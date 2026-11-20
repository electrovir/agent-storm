// cspell:words ptys

import {check} from '@augment-vir/assert';
import {convertDuration} from 'date-vir';
import {existsSync, unlinkSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {daemonSocket} from '../file-paths.js';
import {createDaemonLog} from './daemon-log.js';
import {
    attachHostedProcess,
    killAllHostedProcesses,
    killHostedProcess,
    listHostedProcessIds,
} from './process-pool.js';
import {
    DaemonAction,
    daemonProtocolVersion,
    encodeControlFrame,
    encodeDataFrame,
    FrameDecoder,
    FrameType,
    type AttachedNotification,
    type AttachHandshake,
    type AttachResponse,
    type ClientHandshake,
    type ErrorResponse,
    type ExitNotification,
    type ProcessAttachHandshake,
    type ProcessAttachResponse,
    type ProcessExitNotification,
    type ProcessListResponse,
    type SimpleResponse,
    type StatusResponse,
    type VerifyLaunchResponse,
} from './protocol.js';
import {
    attachPane,
    killAllPanes,
    killFolderPanes,
    killPaneSession,
    listAllPaneStatuses,
    restartPane,
    sweepDeadPanes,
    verifyLaunchSignature,
    writeToPane,
} from './pty-pool.js';

const log = createDaemonLog();

if (daemonSocket.isFile && existsSync(daemonSocket.path)) {
    try {
        unlinkSync(daemonSocket.path);
    } catch (error) {
        log(`failed to remove stale socket: ${String(error)}`);
    }
}

function handleAttach({
    socket,
    decoder,
    handshake: {folder, kind, sessionId, colors, aiCmd, conversationId, env, scrollbackLimit},
}: Readonly<{
    socket: Socket;
    decoder: FrameDecoder;
    handshake: Readonly<AttachHandshake>;
}>): void {
    function onData(data: string) {
        socket.write(encodeDataFrame(data));
    }
    function onExit(exitCode: number | undefined) {
        const notification: ExitNotification = {
            type: 'exit',
            exitCode,
        };
        socket.write(encodeControlFrame(notification));
    }
    const {isNew, isRunning, scrollback, setSize, setColors, detach} = attachPane({
        folder,
        kind,
        sessionId,
        colors,
        aiCmd,
        conversationId,
        env,
        scrollbackLimit,
        onData,
        onExit,
    });
    const response: AttachResponse = {
        ok: true,
        isNew,
        isRunning,
    };
    socket.write(encodeControlFrame(response));
    if (scrollback) {
        socket.write(encodeDataFrame(scrollback));
    }
    socket.on('data', (chunk) => {
        decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).forEach((frame) => {
            if (frame.type === FrameType.Data) {
                writeToPane({
                    folder,
                    kind,
                    sessionId,
                    data: frame.payload.toString('utf-8'),
                });
                return;
            }
            const parsed = JSON.parse(frame.payload.toString('utf-8')) as AttachedNotification;
            if (parsed.type === 'colors') {
                setColors(parsed.colors);
            } else {
                setSize(parsed.cols, parsed.rows);
            }
        });
    });
    function cleanup() {
        detach();
    }
    socket.on('close', cleanup);
    socket.on('error', (error) => {
        log(`socket error on attach: ${error.message}`);
        cleanup();
    });
}

function handleProcessAttach({
    socket,
    decoder,
    handshake: {processId, spawn, isJsonRpc},
}: Readonly<{
    socket: Socket;
    decoder: FrameDecoder;
    handshake: Readonly<ProcessAttachHandshake>;
}>): void {
    /** Set once the response is sent, so output from the attach itself can't precede it. */
    const earlyOutput: Buffer[] = [];
    const state = {
        isResponded: false,
    };
    const attached = attachHostedProcess({
        processId,
        spawnOptions: spawn,
        isJsonRpc: !!isJsonRpc,
        client: {
            onStdout(data) {
                if (state.isResponded) {
                    socket.write(encodeDataFrame(data));
                } else {
                    earlyOutput.push(data);
                }
            },
            onExit({exitCode, signal, stderr}) {
                const notification: ProcessExitNotification = {
                    type: 'process-exit',
                    exitCode,
                    signal,
                    stderr,
                };
                socket.end(encodeControlFrame(notification));
            },
            onReplaced() {
                socket.end();
            },
        },
    });
    if (!attached) {
        reply(socket, {
            ok: false,
            error: `No hosted process: ${processId}`,
        });
        return;
    }
    const response: ProcessAttachResponse = {
        ok: true,
        isNew: attached.isNew,
    };
    socket.write(encodeControlFrame(response));
    state.isResponded = true;
    earlyOutput.forEach((data) => socket.write(encodeDataFrame(data)));
    socket.on('data', (chunk) => {
        decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).forEach((frame) => {
            if (frame.type === FrameType.Data) {
                attached.write(frame.payload);
            }
        });
    });
    socket.on('close', () => attached.detach());
    socket.on('error', (error) => {
        log(`socket error on process attach: ${error.message}`);
        attached.detach();
    });
}

/** Sends the one reply a non-attach action gets, then closes the socket. */
function reply(
    socket: Socket,
    response: Readonly<
        SimpleResponse | StatusResponse | VerifyLaunchResponse | ProcessListResponse | ErrorResponse
    >,
) {
    socket.write(encodeControlFrame(response));
    socket.end();
}

const okResponse: SimpleResponse = {
    ok: true,
};

type HandshakeHandler<Action extends DaemonAction> = (
    params: Readonly<{
        socket: Socket;
        decoder: FrameDecoder;
        handshake: Readonly<Extract<ClientHandshake, {action: Action}>>;
    }>,
) => void;

const handshakeHandlers: {[Action in DaemonAction]: HandshakeHandler<Action>} = {
    [DaemonAction.Attach]: handleAttach,
    [DaemonAction.ProcessAttach]: handleProcessAttach,
    [DaemonAction.ProcessList]({socket}) {
        reply(socket, {
            ok: true,
            processIds: listHostedProcessIds(),
        });
    },
    [DaemonAction.ProcessKill]({socket, handshake}) {
        killHostedProcess(handshake.processId);
        reply(socket, okResponse);
    },
    [DaemonAction.Status]({socket}) {
        reply(socket, {
            ok: true,
            panes: listAllPaneStatuses(),
            protocolVersion: daemonProtocolVersion,
        });
    },
    [DaemonAction.Restart]({socket, handshake}) {
        restartPane({
            folder: handshake.folder,
            kind: handshake.kind,
            sessionId: handshake.sessionId,
            aiCmd: handshake.aiCmd,
            conversationId: handshake.conversationId,
        });
        reply(socket, okResponse);
    },
    [DaemonAction.Kill]({socket, handshake}) {
        killFolderPanes({
            folder: handshake.folder,
        });
        reply(socket, okResponse);
    },
    [DaemonAction.SessionKill]({socket, handshake}) {
        killPaneSession({
            folder: handshake.folder,
            kind: handshake.kind,
            sessionId: handshake.sessionId,
        });
        reply(socket, okResponse);
    },
    [DaemonAction.VerifyLaunch]({socket, handshake}) {
        reply(socket, {
            ok: true,
            isValid: verifyLaunchSignature({
                launchId: handshake.launchId,
                payload: handshake.payload,
                signature: handshake.signature,
            }),
        });
    },
    [DaemonAction.Shutdown]({socket}) {
        reply(socket, okResponse);
        /**
         * Give the OK frame a beat to flush over the socket before tearing the daemon down.
         * `forceShutdown` exits the process; nothing after the timeout runs.
         */
        setTimeout(
            () => forceShutdown('shutdown command'),
            convertDuration(
                {
                    milliseconds: 100,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );
    },
};

const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    let handshakeSeen = false;

    socket.on('error', (error) => {
        log(`socket error: ${error.message}`);
    });

    function handshakeHandler(chunk: Buffer | string) {
        const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const controlFrame = frames.find((frame) => frame.type === FrameType.Control);
        if (!controlFrame || handshakeSeen) {
            return;
        }
        handshakeSeen = true;
        socket.off('data', handshakeHandler);

        const handshake = JSON.parse(controlFrame.payload.toString('utf-8')) as ClientHandshake;

        /**
         * The parsed frame is untrusted socket JSON, so its declared type guarantees nothing at
         * runtime. A newer backend probing with an action this build doesn't know gets an error
         * reply, which it reads as "unsupported" (see {@link DaemonAction.VerifyLaunch}).
         */
        if (!check.isEnumValue(handshake.action, DaemonAction)) {
            log(`unknown action from client: ${String(handshake.action)}`);
            reply(socket, {
                ok: false,
                error: `Unknown daemon action: ${String(handshake.action)}`,
            });
            return;
        }

        (
            handshakeHandlers[
                handshake.action
            ] satisfies HandshakeHandler<any> as HandshakeHandler<DaemonAction>
        )({
            socket,
            decoder,
            handshake,
        });
    }

    socket.on('data', handshakeHandler);
});

server.on('error', (error) => {
    log(`server error: ${error.message}`);
});

server.listen(daemonSocket.path, () => {
    log(`daemon listening on ${daemonSocket.path} (pid ${process.pid})`);
});

/**
 * Backstop for panes whose exit event never arrived — see {@link sweepDeadPanes}. A minute is far
 * shorter than it takes anyone to churn through hundreds of ptys, and the sweep is one
 * `process.kill` per live pane. `unref` so this timer alone can't hold the daemon open.
 */
setInterval(
    () => sweepDeadPanes(),
    convertDuration(
        {
            minutes: 1,
        },
        {
            milliseconds: true,
        },
    ).milliseconds,
).unref();

function shutdown(signal: string): void {
    log(`${signal} received, shutting down`);
    killAllPanes();
    killAllHostedProcesses();
    server.close(() => {
        if (daemonSocket.isFile && existsSync(daemonSocket.path)) {
            try {
                unlinkSync(daemonSocket.path);
            } catch {
                /* ignore */
            }
        }
        process.exit(0);
    });
}

function forceShutdown(reason: string): void {
    log(`force shutdown: ${reason}`);
    killAllPanes();
    killAllHostedProcesses();
    if (daemonSocket.isFile && existsSync(daemonSocket.path)) {
        try {
            unlinkSync(daemonSocket.path);
        } catch {
            /* ignore */
        }
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    log(`uncaught: ${error.stack || error.message}`);
});
process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection: ${String(reason)}`);
});
