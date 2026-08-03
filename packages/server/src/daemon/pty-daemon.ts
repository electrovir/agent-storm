import {type PaneKind} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {existsSync, unlinkSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {daemonSocketPath} from '../file-paths.js';
import {createDaemonLog} from './daemon-log.js';
import {
    DaemonAction,
    daemonProtocolVersion,
    encodeControlFrame,
    encodeDataFrame,
    FrameDecoder,
    FrameType,
    type AttachResponse,
    type ClientHandshake,
    type ErrorResponse,
    type ExitNotification,
    type ResizeNotification,
    type SimpleResponse,
    type StatusResponse,
} from './protocol.js';
import {
    attachPane,
    killAllPanes,
    killFolderPanes,
    killPaneSession,
    listAllPaneStatuses,
    restartPane,
    writeToPane,
} from './pty-pool.js';

const log = createDaemonLog();

if (existsSync(daemonSocketPath)) {
    try {
        unlinkSync(daemonSocketPath);
    } catch (error) {
        log(`failed to remove stale socket: ${String(error)}`);
    }
}

function handleAttach({
    socket,
    decoder,
    folder,
    kind,
    sessionId,
    aiCmd,
    scrollbackLimit,
}: Readonly<{
    socket: Socket;
    decoder: FrameDecoder;
    folder: string;
    kind: PaneKind;
    sessionId: string | undefined;
    aiCmd: string | undefined;
    scrollbackLimit: number | undefined;
}>): void {
    const onData = (data: string) => {
        socket.write(encodeDataFrame(data));
    };
    const onExit = (exitCode: number | undefined) => {
        const notification: ExitNotification = {
            type: 'exit',
            exitCode,
        };
        socket.write(encodeControlFrame(notification));
    };
    const {isNew, scrollback, setSize, detach} = attachPane({
        folder,
        kind,
        sessionId,
        aiCmd,
        scrollbackLimit,
        onData,
        onExit,
    });
    const response: AttachResponse = {
        ok: true,
        isNew,
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
            const parsed = JSON.parse(frame.payload.toString('utf-8')) as ResizeNotification;
            setSize(parsed.cols, parsed.rows);
        });
    });
    const cleanup = () => {
        detach();
    };
    socket.on('close', cleanup);
    socket.on('error', (error) => {
        log(`socket error on attach: ${error.message}`);
        cleanup();
    });
}

const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    let handshakeSeen = false;

    socket.on('error', (error) => {
        log(`socket error: ${error.message}`);
    });

    const handshakeHandler = (chunk: Buffer | string) => {
        const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const controlFrame = frames.find((frame) => frame.type === FrameType.Control);
        if (!controlFrame || handshakeSeen) {
            return;
        }
        handshakeSeen = true;
        socket.off('data', handshakeHandler);

        const handshake = JSON.parse(controlFrame.payload.toString('utf-8')) as ClientHandshake;

        /**
         * Validate the action before dispatching. The parsed frame is untrusted socket JSON, so its
         * declared type guarantees nothing at runtime — and the dispatch below ends in an `else`
         * that shuts the daemon down. Without this gate, a newer backend probing with an action
         * this build doesn't know would land in that branch and kill every pane and VS Code
         * instance across every folder.
         */
        if (!check.isEnumValue(handshake.action, DaemonAction)) {
            log(`unknown action from client: ${String(handshake.action)}`);
            const response: ErrorResponse = {
                ok: false,
                error: `Unknown daemon action: ${String(handshake.action)}`,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
            return;
        }

        if (handshake.action === DaemonAction.Attach) {
            handleAttach({
                socket,
                decoder,
                folder: handshake.folder,
                kind: handshake.kind,
                sessionId: handshake.sessionId,
                aiCmd: handshake.aiCmd,
                scrollbackLimit: handshake.scrollbackLimit,
            });
        } else if (handshake.action === DaemonAction.Status) {
            const response: StatusResponse = {
                ok: true,
                panes: listAllPaneStatuses(),
                protocolVersion: daemonProtocolVersion,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
        } else if (handshake.action === DaemonAction.Restart) {
            restartPane({
                folder: handshake.folder,
                kind: handshake.kind,
                sessionId: handshake.sessionId,
                aiCmd: handshake.aiCmd,
            });
            const response: SimpleResponse = {
                ok: true,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
        } else if (handshake.action === DaemonAction.SessionKill) {
            killPaneSession({
                folder: handshake.folder,
                kind: handshake.kind,
                sessionId: handshake.sessionId,
            });
            const response: SimpleResponse = {
                ok: true,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
        } else if (handshake.action === DaemonAction.Kill) {
            killFolderPanes({
                folder: handshake.folder,
            });
            const response: SimpleResponse = {
                ok: true,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
        } else {
            const response: SimpleResponse = {
                ok: true,
            };
            socket.write(encodeControlFrame(response));
            socket.end();
            /**
             * Give the OK frame a beat to flush over the socket before tearing the daemon down.
             * `forceShutdown` exits the process; nothing after the timeout runs. Only reachable for
             * `Shutdown` now that unknown actions are rejected above.
             */
            setTimeout(() => forceShutdown('shutdown command'), 100);
        }
    };

    socket.on('data', handshakeHandler);
});

server.on('error', (error) => {
    log(`server error: ${error.message}`);
});

server.listen(daemonSocketPath, () => {
    log(`daemon listening on ${daemonSocketPath} (pid ${process.pid})`);
});

function shutdown(signal: string): void {
    log(`${signal} received, shutting down`);
    killAllPanes();
    server.close(() => {
        if (existsSync(daemonSocketPath)) {
            try {
                unlinkSync(daemonSocketPath);
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
    if (existsSync(daemonSocketPath)) {
        try {
            unlinkSync(daemonSocketPath);
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
