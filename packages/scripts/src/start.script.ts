// cspell:words libexec logd pids

/**
 * Sweeps up orphan processes from any prior `npm start` (see {@link killPriorInstances}), then
 * spawns runstorm with the backend (rest-vir + Fastify) and frontend (vite dev server) ports
 * injected as env vars. Both processes see the same ports so they can talk to each other.
 *
 * Honored env (overrides the fixed default ports): BACKEND_PORT port the backend listens on
 * FRONTEND_PORT port vite serves the frontend on
 *
 * Always exported into the child env (consumed by the workspaces): BACKEND_PORT read by
 * packages/server/src/index.ts and packages/frontend/configs/vite.config.ts (inlined into the
 * `VITE_INJECTED_DATA` global so packages/frontend/src/util/global-data.ts can read it at boot)
 * FRONTEND_PORT read by packages/server/src/index.ts (CORS origin guard) and
 * packages/frontend/configs/vite.config.ts (vite's listen port)
 */
import {monorepoRoot} from '@agent-storm/server/src/file-paths.js';
import {defaultPorts, PortEnvVar, readEnvPort} from '@agent-storm/server/src/ports.js';
import {filterMap, log} from '@augment-vir/common';
import {execFileSync, spawn} from 'node:child_process';

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
    const psOutput = execFileSync(
        '/bin/ps',
        [
            '-A',
            '-ww',
            '-o',
            'pid=,command=',
        ],
        {
            encoding: 'utf8',
        },
    );
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
        (entry): entry is {pid: number; command: string} => {
            return (
                entry != undefined &&
                entry.pid !== process.pid &&
                entry.command.includes(monorepoRoot) &&
                orphanIndicators.some((indicator) => entry.command.includes(indicator)) &&
                !orphanExclusions.some((exclusion) => entry.command.includes(exclusion))
            );
        },
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

const backendPort = readEnvPort(PortEnvVar.Backend) ?? defaultPorts[PortEnvVar.Backend];
const frontendPort = readEnvPort(PortEnvVar.Frontend) ?? defaultPorts[PortEnvVar.Frontend];

const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [PortEnvVar.Backend]: String(backendPort),
    [PortEnvVar.Frontend]: String(frontendPort),
};

log.faint(
    `agent-storm ports: backend=${backendPort} frontend=${frontendPort}` +
        ' (override with BACKEND_PORT / FRONTEND_PORT env vars)',
);

/**
 * Wait before restarting a service that exited, so one that fails immediately (a port still held by
 * a dying process) prints its error at a readable pace instead of scrolling the terminal.
 */
const restartDelaySeconds = 2;

/**
 * Keep a service alive for the life of `npm start`. Both services are servers, so every exit is a
 * failure — including being killed from outside, which runstorm reports as exit code 0 because a
 * signaled child closes with a null code and runstorm falls back to 0. The echoed status is the
 * shell's, where a kill reads as 128 plus the signal number, which is what separates a crash from
 * something sweeping the process up.
 */
function supervised(command: string): string {
    return `while true; do ${command}; echo "exited with status $?; restarting in ${restartDelaySeconds}s"; sleep ${restartDelaySeconds}; done`;
}

const child = spawn(
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    'npx',
    [
        'runstorm',
        '--colors',
        'green,blue',
        '--names',
        'backend,frontend',
        supervised('npm start --workspace @agent-storm/server'),
        supervised('npm start --workspace @agent-storm/frontend'),
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
