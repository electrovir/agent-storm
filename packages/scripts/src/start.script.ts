/**
 * Spawns runstorm with fixed backend/frontend ports injected as env vars. Both processes (and
 * any tooling that reads `import.meta.env` for the vite case) see the same ports so they can
 * talk to each other.
 *
 * Always exported into the child env (consumed by the workspaces):
 *   BACKEND_PORT       — read by packages/server/src/index.ts
 *   FRONTEND_PORT      — read by packages/server/src/index.ts (CORS origin guard)
 *   VITE_BACKEND_PORT  — read by packages/frontend/src/util/service-origin.ts at boot
 *   VITE_FRONTEND_PORT — read by packages/frontend/configs/vite.config.ts (vite's listen port)
 */
import {monorepoRoot} from '@agent-storm/server/src/file-paths.js';
import {filterMap, log} from '@augment-vir/common';
import {execFileSync, execSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:net';

type Signals = NodeJS.Signals;

/**
 * Fixed ports — never auto-picked, never walked. Two intentional consequences:
 *
 *   1. The frontend bundle is baked with a single backend URL that's stable across runs, so
 *      reloads and Electron window restarts always reach the same backend. (Auto-picking led
 *      to "Failed to fetch" after every open/close cycle when the new port didn't match the
 *      port the renderer was loaded against.)
 *
 *   2. A second `npm start` (or `npm run dev:electron`) while one is already running fails
 *      fast at the port-bind check below, instead of silently piling up another stack. This
 *      makes "multiple stacks accumulating" structurally impossible — the only way to run
 *      two simultaneously is to kill the first.
 *
 * Picked from the upper IANA unassigned range — above noisy dev-tool defaults
 * (3000/4000/5173/8000/8080/9000), below macOS's ephemeral range (49152+), with no nearby
 * IANA-registered services.
 */
const orphanIndicators = [
    '/packages/server/src/index',
    '/packages/scripts/src/start.script',
    '/node_modules/.bin/virmator',
    '/node_modules/virmator/',
    '/node_modules/runstorm/',
    'configs/vite.config.ts',
];

/**
 * The pty-daemon is intentionally detached (spawned in `ensureDaemon` with `detached: true`) so
 * that terminal sessions survive backend restarts. Never sweep it up.
 */
const orphanExclusions = [
    'pty-daemon',
];

/**
 * Runstorm spawns its children in detached process groups and tears them down via
 * `process.kill(-pid, 'SIGTERM')` on shutdown — which works when the orchestrator gets a clean
 * chance to run its handler. In practice, the `npm start --workspace ...` shim sometimes swallows
 * SIGTERM, or the terminal closes abruptly, leaving the vite / tsx tree alive with `ppid=1` and
 * still holding the dev ports. That stale tree forces the next `npm start` onto different ports and
 * causes CORS drift between the browser tab (pointed at the old vite) and the new backend's
 * port-scoped origin guard. This sweep clears any prior survivors before we allocate fresh ports.
 */
function killPriorInstances(): void {
    /**
     * Absolute path to `ps` (rather than `'ps'` resolved through `PATH`) so a hostile entry on the
     * user's `PATH` can't supplant the system binary we depend on.
     */
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const psOutput = execSync('ps -A -ww -o pid=,command=', {
        encoding: 'utf8',
    });
    const orphanPids = filterMap(
        psOutput.split('\n'),
        (line: string) => {
            /**
             * Lines look like `<right-aligned pid><spaces><command>` (e.g. ` 606
             * /usr/libexec/logd`). Parse via index math rather than a regex with `\s+` quantifiers
             * — the regex form trips ReDoS lints and a plain index lookup is both faster and easier
             * to audit.
             */
            const trimmed = line.trimStart();
            const separatorIndex = trimmed.indexOf(' ');
            if (separatorIndex <= 0) {
                return undefined;
            }
            const pid = Number(trimmed.slice(0, separatorIndex));
            if (!Number.isInteger(pid)) {
                return undefined;
            }
            return {
                pid,
                command: trimmed.slice(separatorIndex + 1).trimStart(),
            };
        },
        (entry): entry is {pid: number; command: string} =>
            entry != undefined &&
            entry.pid !== process.pid &&
            entry.command.includes(monorepoRoot) &&
            orphanIndicators.some((indicator) => entry.command.includes(indicator)) &&
            !orphanExclusions.some((exclusion) => entry.command.includes(exclusion)),
    ).map((entry) => entry.pid);

    if (orphanPids.length === 0) {
        return;
    }

    log.faint(
        `agent-storm: cleaning up ${orphanPids.length} orphan process(es) from a prior session: ${orphanPids.join(', ')}`,
    );

    orphanPids.forEach((pid) => {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* Already gone; nothing to do. */
        }
    });
}

killPriorInstances();

/**
 * Fixed ports. Picked from the upper IANA unassigned range — above the noisy dev-tool defaults
 * (3000/4000/5173/8000/8080/9000) and below the ephemeral range macOS uses for outbound connections
 * (49152+), with no nearby IANA-registered services. Hard-coded (no auto-walk-up on a busy port) so
 * the URL the user has bookmarked / open in their browser is stable across restarts. If a stale
 * process is squatting on the port, the relevant server fails loudly with EADDRINUSE rather than
 * silently moving — that's the desired behavior: free the port and try again instead of producing a
 * session where the browser is pointed at the wrong port and quietly fails CORS.
 */
const defaultBackendPort = 41_880;
const defaultFrontendPort = 41_881;

function envPort(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
        return undefined;
    }
    return parsed;
}

const backendPort = envPort('BACKEND_PORT') ?? defaultBackendPort;
const frontendPort = envPort('FRONTEND_PORT') ?? defaultFrontendPort;

/**
 * Probe `127.0.0.1:<port>` with a fresh listener. If the bind succeeds the port is free; if
 * it throws (EADDRINUSE), something else is already on it. We do the probe in this script
 * — not inside the backend or vite — so we can fail with a clear, actionable error before
 * runstorm spawns three workspaces that would otherwise each emit their own opaque
 * port-in-use crash.
 */
async function assertPortFree(port: number, label: string): Promise<void> {
    await new Promise<void>((res, rej) => {
        const server = createServer();
        server.once('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                rej(
                    new Error(
                        `agent-storm: port ${port} (${label}) is already in use. ` +
                            `Another agent-storm stack is probably running — close that window ` +
                            `or kill the process listening on ${port}, then try again.`,
                    ),
                );
            } else {
                rej(error);
            }
        });
        server.once('listening', () => {
            server.close(() => res());
        });
        server.listen(port, '127.0.0.1');
    });
}

/**
 * Linux-only: read /proc/<pid>/stat for the parent PID. /proc/<pid>/stat is
 * `pid (comm) state ppid ...` and `comm` can contain spaces and parens, so split
 * after the last `)` to find ppid. Returns undefined on non-Linux or if the pid
 * is already gone — the caller handles that by just not walking further.
 */
function getParentPid(pid: number): number | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        const ppid = Number.parseInt(tail[1] ?? '', 10);
        return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
    } catch {
        return undefined;
    }
}

function getCmdline(pid: number): string {
    try {
        return readFileSync(`/proc/${pid}/cmdline`).toString().replace(/\0/g, ' ').trim();
    } catch {
        return '';
    }
}

/**
 * Matches the binaries that show up in an agent-storm process tree (`npm start`,
 * `tsx --watch`, `vite`, `electron`, `runstorm`, anything called `agent-storm`).
 * Used to bound the ancestor walk so we kill the watchers/launchers above the
 * listener but stop before reaching the user's shell or terminal emulator.
 */
const stackProcessPattern = /\b(npm|tsx|electron|vite|runstorm|agent-storm)\b/;

function findListenerPids(port: number): number[] {
    try {
        const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out
            .split('\n')
            .filter(Boolean)
            .map((line) => Number.parseInt(line, 10))
            .filter(Number.isInteger);
    } catch {
        return [];
    }
}

function stackAncestors(pid: number): number[] {
    const chain: number[] = [pid];
    let current: number | undefined = pid;
    while ((current = getParentPid(current)) !== undefined) {
        if (!stackProcessPattern.test(getCmdline(current))) {
            break;
        }
        chain.push(current);
    }
    return chain;
}

/**
 * Identify the agent-storm tree(s) holding `port` and SIGKILL them. We climb to
 * the highest still-stack-shaped ancestor of each listener because a `tsx --watch`
 * or `electron` parent would otherwise respawn the listener between our kill and
 * the re-bind, racing us back into EADDRINUSE. SIGKILL (not SIGTERM) for the same
 * reason — graceful shutdown gives watchers time to fork a replacement.
 */
async function reclaimPort(port: number, label: string): Promise<void> {
    const listeners = findListenerPids(port);
    if (listeners.length === 0) {
        return;
    }
    const pids = new Set<number>();
    for (const listener of listeners) {
        for (const ancestor of stackAncestors(listener)) {
            pids.add(ancestor);
        }
    }
    console.warn(
        `agent-storm: ${label} port ${port} held by pid(s) ${[...pids].join(', ')} — killing to reclaim.`,
    );
    for (const pid of pids) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* already exited */
        }
    }
}

async function ensurePortFree(port: number, label: string): Promise<void> {
    try {
        await assertPortFree(port, label);
        return;
    } catch (firstError) {
        await reclaimPort(port, label);
        // Kernel takes a moment to release the listening socket after the holder
        // exits; poll for up to ~3s before giving up and surfacing the original error.
        for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            try {
                await assertPortFree(port, label);
                return;
            } catch {
                /* still bound — retry */
            }
        }
        throw firstError;
    }
}

try {
    await ensurePortFree(backendPort, 'backend');
    await ensurePortFree(frontendPort, 'frontend');
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

/**
 * Passing `--electron` enables desktop-app mode: the same backend + vite stack still runs, plus
 * an Electron main process that opens a BrowserWindow pointing at vite once it's ready. The
 * frontend code is identical in both modes.
 */
const withElectron = process.argv.includes('--electron');

/**
 * In Electron mode we generate a fresh 256-bit bearer once per launch and inject it into both
 * the backend and the Electron main process via env. The backend treats this value as the only
 * accepted bearer (no on-disk file, no argon2 dance — see `packages/server/src/auth.ts`); the
 * Electron main process forwards it to the renderer via the preload, so the auth modal never
 * shows. The secret rotates on every restart and never touches disk. A local process running
 * as the same user could still read `/proc/<pid>/environ`, but that attacker can also read
 * `~/.ssh/id_rsa` and is out of scope.
 *
 * Browser-mode (`npm start` without `--electron`) skips this and keeps the persistent
 * file-backed argon2 flow so the user can save the bearer once and reuse it across restarts.
 */
const runtimeSecret = withElectron ? randomBytes(32).toString('hex') : undefined;

const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BACKEND_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
    VITE_BACKEND_PORT: String(backendPort),
    VITE_FRONTEND_PORT: String(frontendPort),
    ...(runtimeSecret ? {AGENT_STORM_RUNTIME_SECRET: runtimeSecret} : {}),
};

console.log(`agent-storm ports: backend=${backendPort} frontend=${frontendPort}`);

/**
 * `--kill-on exit` makes runstorm tear down all surviving children the moment any one of them
 * exits. So closing the Electron window (which calls `app.quit()` → electron child exits)
 * cascades into backend + vite teardown, and `child.on('exit')` below propagates the same
 * exit code up so this script exits too. Combined with the fixed-port check above, the
 * full-stack lifecycle is locked to a single window.
 */
const runstormArgs = [
    'runstorm',
    '--kill-on',
    'exit',
    '--colors',
    withElectron ? 'green,blue,magenta' : 'green,blue',
    '--names',
    withElectron ? 'backend,frontend,electron' : 'backend,frontend',
    'npm start --workspace @agent-storm/server',
    'npm start --workspace @agent-storm/frontend',
];
if (withElectron) {
    runstormArgs.push('npm start --workspace @agent-storm/electron');
}

const child = spawn('npx', runstormArgs, {
    stdio: 'inherit',
    env: childEnv,
});

function forward(signal: Signals): void {
    process.on(signal, () => {
        if (!child.killed) child.kill(signal);
    });
}
forward('SIGINT');
forward('SIGTERM');
forward('SIGHUP');

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
    } else {
        process.exit(code ?? 0);
    }
});
