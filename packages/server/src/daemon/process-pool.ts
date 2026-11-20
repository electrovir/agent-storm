import {check} from '@augment-vir/assert';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {convertDuration} from 'date-vir';
import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {createDaemonLog} from './daemon-log.js';
import {killProcessTree, snapshotProcessTable} from './kill-process-tree.js';
import {type HostedProcessSpawn, type ProcessExitNotification} from './protocol.js';

const log = createDaemonLog('process');

/**
 * Output held for a detached process. A process that outgrows this while nobody listens is killed,
 * since dropping part of its stdout would corrupt the protocol it speaks.
 */
const maxDetachedOutputBytes = 64 * 1024 * 1024;
const maxStderrTailLength = 4000;

/** Who receives a hosted process's output. At most one client is attached at a time. */
export type HostedProcessClient = {
    onStdout: (data: Buffer) => void;
    onExit: (exit: Readonly<Omit<ProcessExitNotification, 'type'>>) => void;
    /** Another client attached to the same process and took it over. */
    onReplaced: () => void;
};

type OpenRequest = {
    line: string;
    /** Whether a client was sent this request, rather than it waiting in `detachedOutput`. */
    isDelivered: boolean;
};

type HostedProcess = {
    child: ChildProcessWithoutNullStreams;
    client: HostedProcessClient | undefined;
    detachedOutput: Buffer[];
    detachedBytes: number;
    detachedTimer: NodeJS.Timeout | undefined;
    stderrTail: string;
    isJsonRpc: boolean;
    /** JSON-RPC requests from the process that no stdin line has answered yet, keyed by id. */
    openRequests: Map<string, OpenRequest>;
    /** A pipe chunk can end inside a multi-byte character, which these carry to the next chunk. */
    stdoutDecoder: StringDecoder;
    stdinDecoder: StringDecoder;
    partialStdoutLine: string;
    partialStdinLine: string;
};

const hostedProcesses = new Map<string, HostedProcess>();

/** Parses a JSON-RPC line into its id and whether it carries a method, or nothing when it isn't one. */
function readRpcLine(line: string): {idKey: string; hasMethod: boolean} | undefined {
    try {
        const parsed: unknown = JSON.parse(line);
        if (!check.isObject(parsed) || !('id' in parsed) || parsed.id == undefined) {
            return undefined;
        }
        return {
            idKey: JSON.stringify(parsed.id),
            hasMethod: 'method' in parsed,
        };
    } catch {
        return undefined;
    }
}

/** Splits `data` into complete lines, keeping the unterminated remainder for the next chunk. */
function splitLines({partial, data}: Readonly<{partial: string; data: string}>) {
    const lines = (partial + data).split('\n');
    return {
        lines: lines.slice(0, -1),
        partial: lines.at(-1) || '',
    };
}

function output(processId: string, entry: HostedProcess, data: Buffer): void {
    if (entry.client) {
        entry.client.onStdout(data);
    } else if (entry.detachedBytes <= maxDetachedOutputBytes) {
        /** Past the limit, the process is already being killed. */
        entry.detachedOutput.push(data);
        entry.detachedBytes += data.length;
        if (entry.detachedBytes > maxDetachedOutputBytes) {
            log(`${processId} killed: too much output while detached`);
            killHostedProcess(processId);
        }
    }
}

function handleStdout(processId: string, entry: HostedProcess, chunk: Buffer): void {
    if (!entry.isJsonRpc) {
        output(processId, entry, chunk);
        return;
    }
    const {lines, partial} = splitLines({
        partial: entry.partialStdoutLine,
        data: entry.stdoutDecoder.write(chunk),
    });
    entry.partialStdoutLine = partial;
    lines.forEach((line) => {
        const rpcLine = readRpcLine(line);
        if (rpcLine?.hasMethod) {
            entry.openRequests.set(rpcLine.idKey, {
                line,
                isDelivered: !!entry.client,
            });
        }
        output(processId, entry, Buffer.from(`${line}\n`));
    });
}

function startProcess(
    processId: string,
    {command, args, cwd, env}: Readonly<HostedProcessSpawn>,
    isJsonRpc: boolean,
): HostedProcess {
    const child = spawn(command, args, {
        cwd,
        env,
        stdio: 'pipe',
    });
    const entry: HostedProcess = {
        child,
        client: undefined,
        detachedOutput: [],
        detachedBytes: 0,
        detachedTimer: undefined,
        stderrTail: '',
        isJsonRpc,
        openRequests: new Map(),
        stdoutDecoder: new StringDecoder('utf8'),
        stdinDecoder: new StringDecoder('utf8'),
        partialStdoutLine: '',
        partialStdinLine: '',
    };
    child.stdout.on('data', (chunk: Buffer) => handleStdout(processId, entry, chunk));
    child.stderr.on('data', (chunk: Buffer) => {
        entry.stderrTail = (entry.stderrTail + chunk.toString('utf-8')).slice(-maxStderrTailLength);
    });
    /** A process that already exited closes stdin, and writing to it then raises EPIPE here. */
    child.stdin.on('error', (error) => {
        log(`${processId} stdin error: ${error.message}`);
    });
    child.on('error', (error) => {
        entry.stderrTail = (entry.stderrTail + error.message).slice(-maxStderrTailLength);
    });
    /** `close` waits for stdout to drain, unlike `exit`, so the client gets all output first. */
    child.on('close', (exitCode, signal) => {
        clearTimeout(entry.detachedTimer);
        if (hostedProcesses.get(processId) === entry) {
            hostedProcesses.delete(processId);
        }
        log(`${processId} exited (code ${String(exitCode)}, signal ${String(signal)})`);
        entry.client?.onExit({
            exitCode,
            signal,
            stderr: entry.stderrTail,
        });
    });
    log(`${processId} started (pid ${String(child.pid)})`);
    return entry;
}

/**
 * Attaches `client` to the hosted process `processId`, starting it from `spawnOptions` when none
 * runs. Output the process wrote while detached is delivered first. Returns nothing when no such
 * process runs and `spawnOptions` is unset.
 */
export function attachHostedProcess({
    processId,
    spawnOptions,
    isJsonRpc,
    client,
}: Readonly<{
    processId: string;
    spawnOptions: Readonly<HostedProcessSpawn> | undefined;
    isJsonRpc: boolean;
    client: HostedProcessClient;
}>) {
    const existing = hostedProcesses.get(processId);
    const entry =
        existing || (spawnOptions ? startProcess(processId, spawnOptions, isJsonRpc) : undefined);
    if (!entry) {
        return undefined;
    }
    hostedProcesses.set(processId, entry);

    const previousClient = entry.client;
    entry.client = client;
    clearTimeout(entry.detachedTimer);
    entry.detachedTimer = undefined;
    previousClient?.onReplaced();

    /**
     * Requests a previous client was sent may have died with it unanswered, so they go out again.
     * Requests still waiting in `detachedOutput` go out with it below instead.
     */
    entry.openRequests.forEach((request) => {
        if (request.isDelivered) {
            client.onStdout(Buffer.from(`${request.line}\n`));
        }
        request.isDelivered = true;
    });
    entry.detachedOutput.forEach((data) => client.onStdout(data));
    entry.detachedOutput = [];
    entry.detachedBytes = 0;

    return {
        isNew: !existing,
        write(data: Buffer) {
            if (hostedProcesses.get(processId) !== entry || entry.client !== client) {
                return;
            }
            entry.child.stdin.write(data);
            if (!entry.isJsonRpc) {
                return;
            }
            const {lines, partial} = splitLines({
                partial: entry.partialStdinLine,
                data: entry.stdinDecoder.write(data),
            });
            entry.partialStdinLine = partial;
            lines.forEach((line) => {
                const rpcLine = readRpcLine(line);
                if (rpcLine && !rpcLine.hasMethod) {
                    entry.openRequests.delete(rpcLine.idKey);
                }
            });
        },
        detach() {
            if (entry.client !== client) {
                return;
            }
            entry.client = undefined;
            if (hostedProcesses.get(processId) !== entry) {
                return;
            }
            /**
             * A backend that never comes back would otherwise leave the process running for as long
             * as the daemon lives.
             */
            entry.detachedTimer = setTimeout(
                () => {
                    log(`${processId} killed: detached too long`);
                    killHostedProcess(processId);
                },
                convertDuration(
                    {
                        minutes: 30,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            );
            entry.detachedTimer.unref();
        },
    };
}

export function listHostedProcessIds(): string[] {
    return [...hostedProcesses.keys()];
}

/** Kills a hosted process's whole tree. Its attached client still hears about the exit. */
const processTreeKillers: Record<
    OperatingSystem,
    (
        child: Readonly<ChildProcessWithoutNullStreams>,
        options: Readonly<{immediate: boolean; processTable: string | undefined}>,
    ) => void
> = {
    [OperatingSystem.Mac]: killUnixProcessTree,
    [OperatingSystem.Linux]: killUnixProcessTree,
    [OperatingSystem.Windows](child) {
        child.kill();
    },
};

function killUnixProcessTree(
    child: Readonly<ChildProcessWithoutNullStreams>,
    {immediate, processTable}: Readonly<{immediate: boolean; processTable: string | undefined}>,
): void {
    if (child.pid == undefined) {
        return;
    }
    killProcessTree(child.pid, {
        expectedParentPid: process.pid,
        immediate,
        processTable,
    });
}

export function killHostedProcess(
    processId: string,
    {
        immediate = false,
        processTable,
    }: Readonly<{
        immediate?: boolean | undefined;
        processTable?: string | undefined;
    }> = {},
): void {
    const entry = hostedProcesses.get(processId);
    if (!entry) {
        return;
    }
    clearTimeout(entry.detachedTimer);
    processTreeKillers[currentOperatingSystem](entry.child, {
        immediate,
        processTable,
    });
}

/** Synchronously kills every hosted process, for daemon shutdown. */
export function killAllHostedProcesses(): void {
    if (!hostedProcesses.size) {
        return;
    }
    const processTable = snapshotProcessTable();
    [...hostedProcesses.keys()].forEach((processId) => {
        return killHostedProcess(processId, {
            immediate: true,
            processTable,
        });
    });
}
