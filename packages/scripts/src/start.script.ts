// cspell:words libexec, logd, Pids

/**
 * Sweeps up orphan processes from any prior `npm start` (see {@link killPriorInstances}), then
 * allocates free ports for the backend (rest-vir + Fastify) and the frontend (vite dev server),
 * then spawns runstorm with the chosen ports injected as env vars. Both processes see the same
 * ports so they can talk to each other.
 *
 * Honored env (override the auto-allocation): BACKEND_PORT port the backend listens on
 * FRONTEND_PORT port vite serves the frontend on
 *
 * Always exported into the child env (consumed by the workspaces): BACKEND_PORT read by
 * packages/server/src/index.ts and packages/frontend/configs/vite.config.ts (inlined into the
 * `VITE_INJECTED_DATA` global so packages/frontend/src/util/global-data.ts can read it at boot)
 * FRONTEND_PORT read by packages/server/src/index.ts (CORS origin guard) and
 * packages/frontend/configs/vite.config.ts (vite's listen port)
 */
import {monorepoRoot} from '@agent-storm/server/src/file-paths.js';
import {filterMap, log} from '@augment-vir/common';
import {execSync, spawn} from 'node:child_process';

type Signals = NodeJS.Signals;

/**
 * Substrings that identify a process spawned by a prior `npm start` of this monorepo. A process is
 * considered an orphan only when its full command line contains {@link monorepoRoot} AND at least
 * one of these substrings. The path anchor keeps us from killing unrelated `vite` / `virmator`
 * processes elsewhere on the machine; the substring requirement keeps us from killing IDE-side
 * tooling (tsserver, eslintServer, cspell) that also runs out of this monorepo's `node_modules`.
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

const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    BACKEND_PORT: String(backendPort),
    FRONTEND_PORT: String(frontendPort),
};

log.faint(
    `agent-storm ports: backend=${backendPort} frontend=${frontendPort}` +
        ' (override with BACKEND_PORT / FRONTEND_PORT env vars)',
);

const child = spawn(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'npx',
    [
        'runstorm',
        '--colors',
        'green,blue',
        '--names',
        'backend,frontend',
        'npm start --workspace @agent-storm/server',
        'npm start --workspace @agent-storm/frontend',
    ],
    {
        stdio: 'inherit',
        env: childEnv,
    },
);

function forward(signal: Signals): void {
    process.on(signal, () => {
        if (!child.killed) {
            child.kill(signal);
        }
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
