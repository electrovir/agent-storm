// cspell:words lastexitcode libexec logd pids

/**
 * Sweeps up orphan processes from any prior `npm start` of the same instance (see
 * {@link killPriorInstances}), then spawns runstorm with the backend (rest-vir + Fastify) and
 * frontend (vite dev server) ports injected as env vars. Both processes see the same ports so they
 * can talk to each other.
 *
 * Honored env (overrides the fixed default ports): BACKEND_PORT port the backend listens on
 * FRONTEND_PORT port vite serves the frontend on. AGENT_STORM_INSTANCE and AGENT_STORM_DATA_DIR
 * (see `InstanceEnvVar`) run a separate instance with its own pty daemon and files; a named
 * instance must also set both ports.
 *
 * Always exported into the child env (consumed by the workspaces): BACKEND_PORT read by
 * packages/server/src/index.ts and packages/frontend/configs/vite.config.ts (inlined into the
 * `VITE_INJECTED_DATA` global so packages/core/src/frontend/util/global-data.ts can read it at
 * boot) FRONTEND_PORT read by packages/server/src/index.ts (CORS origin guard) and
 * packages/frontend/configs/vite.config.ts (vite's listen port)
 */
import {monorepoRoot, runstormCliPath} from '@agent-storm/server/src/file-paths.js';
import {filterMap, log} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {
    defaultPorts,
    defaultUserDataDir,
    InstanceEnvVar,
    instanceName,
    PortEnvVar,
    readEnvPort,
    userDataDir,
} from 'agent-storm';
import {spawn, spawnSync} from 'node:child_process';

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

type ProcessEntry = {
    pid: number;
    command: string;
};

/**
 * `ps` output as pid and command line, selected by `selectArgs`. `spawnSync` rather than
 * `execFileSync` because `ps -p` exits non-zero when every listed process has already exited.
 */
function listProcesses(selectArgs: ReadonlyArray<string>) {
    /**
     * Absolute path to `ps` (rather than `'ps'` resolved through `PATH`) so a hostile entry on the
     * user's `PATH` can't supplant the system binary we depend on.
     */
    const psOutput = spawnSync(
        '/bin/ps',
        [
            '-ww',
            ...selectArgs,
            '-o',
            'pid=,command=',
        ],
        {
            encoding: 'utf8',
        },
    ).stdout;
    return filterMap(
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
        (entry): entry is ProcessEntry => entry != undefined,
    );
}

/**
 * The instance a process was started for. Every instance runs the same commands from the same
 * checkout, so only the process's environment tells them apart; `ps -E` appends it after the
 * command line. Processes without `AGENT_STORM_INSTANCE` belong to the default instance.
 */
function readProcessInstance({
    command,
    commandWithEnvironment,
}: Readonly<{
    command: string;
    commandWithEnvironment: string;
}>) {
    const prefix = `${InstanceEnvVar.Name}=`;
    const variable = commandWithEnvironment
        .slice(command.length)
        .split(' ')
        .find((part) => part.startsWith(prefix));
    return variable?.slice(prefix.length) || '';
}

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
    const candidates = listProcesses([
        '-A',
    ]).filter((entry) => {
        return (
            entry.pid !== process.pid &&
            entry.command.includes(monorepoRoot) &&
            orphanIndicators.some((indicator) => entry.command.includes(indicator)) &&
            !orphanExclusions.some((exclusion) => entry.command.includes(exclusion))
        );
    });
    if (!candidates.length) {
        return;
    }
    /**
     * Only for the candidates: every process's environment together overflows `spawnSync`'s default
     * output buffer.
     */
    const withEnvironment = listProcesses([
        '-E',
        '-p',
        candidates.map((entry) => entry.pid).join(','),
    ]);
    const orphanPids = candidates
        .filter((candidate) => {
            const commandWithEnvironment = withEnvironment.find(
                (entry) => entry.pid === candidate.pid,
            )?.command;
            return (
                commandWithEnvironment?.startsWith(candidate.command) === true &&
                readProcessInstance({
                    command: candidate.command,
                    commandWithEnvironment,
                }) === instanceName
            );
        })
        .map((entry) => entry.pid);

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

const backendPort = readEnvPort(PortEnvVar.Backend) ?? defaultPorts[PortEnvVar.Backend];
const frontendPort = readEnvPort(PortEnvVar.Frontend) ?? defaultPorts[PortEnvVar.Frontend];

if (
    instanceName &&
    (backendPort === defaultPorts[PortEnvVar.Backend] ||
        frontendPort === defaultPorts[PortEnvVar.Frontend] ||
        userDataDir === defaultUserDataDir)
) {
    throw new Error(
        `Instance "${instanceName}" would share ports or ${defaultUserDataDir} with the default instance. Set ${PortEnvVar.Backend}, ${PortEnvVar.Frontend}, and ${InstanceEnvVar.DataDir} to values of its own.`,
    );
}

(
    ({
        [OperatingSystem.Mac]: killPriorInstances,
        [OperatingSystem.Linux]: killPriorInstances,
        /** Windows has no `ps` to find them with. */
        [OperatingSystem.Windows]() {},
    }) satisfies Record<OperatingSystem, () => void>
)[currentOperatingSystem]();

const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [PortEnvVar.Backend]: String(backendPort),
    [PortEnvVar.Frontend]: String(frontendPort),
    [InstanceEnvVar.Name]: instanceName,
    [InstanceEnvVar.DataDir]: userDataDir,
};

const instanceLabel = instanceName ? ` instance "${instanceName}"` : '';

log.faint(
    `agent-storm${instanceLabel}: backend=${backendPort} frontend=${frontendPort} data=${userDataDir}` +
        ' (override with BACKEND_PORT / FRONTEND_PORT / AGENT_STORM_INSTANCE / AGENT_STORM_DATA_DIR env vars)',
);

/**
 * Wait before restarting a service that exited, so one that fails immediately (a port still held by
 * a dying process) prints its error at a readable pace instead of scrolling the terminal.
 */
const restartDelaySeconds = 2;

const unixSupervisor = {
    shell: 'bash',
    supervise(command: string) {
        return `while true; do ${command}; echo "exited with status $?; restarting in ${restartDelaySeconds}s"; sleep ${restartDelaySeconds}; done`;
    },
};

/**
 * Keeps a service alive for the life of `npm start`. Both services are servers, so every exit is a
 * failure — including being killed from outside, which runstorm reports as exit code 0 because a
 * signaled child closes with a null code and runstorm falls back to 0. The echoed status is the
 * shell's, where a kill reads as 128 plus the signal number, which is what separates a crash from
 * something sweeping the process up.
 */
const supervisor = (
    {
        [OperatingSystem.Mac]: unixSupervisor,
        [OperatingSystem.Linux]: unixSupervisor,
        [OperatingSystem.Windows]: {
            shell: 'powershell',
            supervise(command: string) {
                return `while ($true) { ${command}; Write-Host "exited with status $LASTEXITCODE; restarting in ${restartDelaySeconds}s"; Start-Sleep ${restartDelaySeconds} }`;
            },
        },
    } satisfies Record<OperatingSystem, {shell: string; supervise: (command: string) => string}>
)[currentOperatingSystem];

const child = spawn(
    process.execPath,
    [
        runstormCliPath,
        '--shell',
        supervisor.shell,
        '--colors',
        'green,blue',
        '--names',
        'backend,frontend',
        supervisor.supervise('npm start --workspace @agent-storm/server'),
        supervisor.supervise('npm start --workspace @agent-storm/frontend'),
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
