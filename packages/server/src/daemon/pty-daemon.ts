import {PaneKind} from '@agent-storm/common';
import {appendFileSync, existsSync, unlinkSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {daemonLogPath, daemonSocketPath} from './daemon-paths.js';
import {
    DaemonAction,
    encodeControlFrame,
    encodeDataFrame,
    FrameDecoder,
    FrameType,
    type AttachResponse,
    type ClientHandshake,
    type ErrorResponse,
    type ExitNotification,
    type SimpleResponse,
    type StatusResponse,
} from './protocol.js';
import {
    attachPane,
    killFolderPanes,
    listAllPaneStatuses,
    restartPane,
    writeToPane,
} from './pty-pool.js';

function log(message: string): void {
    try {
        appendFileSync(daemonLogPath, `[${new Date().toISOString()}] ${message}\n`);
    } catch {
        /* swallow log errors so they never crash the daemon */
    }
}

if (existsSync(daemonSocketPath)) {
    try {
        unlinkSync(daemonSocketPath);
    } catch (error) {
        log(`failed to remove stale socket: ${String(error)}`);
    }
}

function sendError(socket: Socket, message: string): void {
    const response: ErrorResponse = {
        ok: false,
        error: message,
    };
    socket.write(encodeControlFrame(response));
    socket.end();
}

function handleAttach(socket: Socket, decoder: FrameDecoder, folder: string, kind: PaneKind): void {
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
    const {isNew, scrollback, detach} = attachPane({
        folder,
        kind,
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
                    data: frame.payload.toString('utf-8'),
                });
            }
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
        if (!controlFrame) {
            return;
        }
        if (handshakeSeen) {
            return;
        }
        handshakeSeen = true;
        socket.off('data', handshakeHandler);

        const handshake = JSON.parse(controlFrame.payload.toString('utf-8')) as ClientHandshake;

        if (handshake.action === DaemonAction.Attach) {
            handleAttach(socket, decoder, handshake.folder, handshake.kind);
            return;
        }
        if (handshake.action === DaemonAction.Status) {
            const response: StatusResponse = {
                ok: true,
                panes: listAllPaneStatuses(),
            };
            socket.write(encodeControlFrame(response));
            socket.end();
            return;
        }
        if (handshake.action === DaemonAction.Restart) {
            restartPane({folder: handshake.folder, kind: handshake.kind});
            const response: SimpleResponse = {ok: true};
            socket.write(encodeControlFrame(response));
            socket.end();
            return;
        }
        if (handshake.action === DaemonAction.Kill) {
            killFolderPanes({folder: handshake.folder});
            const response: SimpleResponse = {ok: true};
            socket.write(encodeControlFrame(response));
            socket.end();
            return;
        }
        if (handshake.action === DaemonAction.Shutdown) {
            const response: SimpleResponse = {ok: true};
            socket.write(encodeControlFrame(response));
            socket.end();
            /**
             * Give the OK frame a beat to flush over the socket before tearing the daemon down.
             * `forceShutdown` exits the process; nothing after the timeout runs.
             */
            setTimeout(() => forceShutdown('shutdown command'), 100);
            return;
        }
        sendError(socket, `Unknown action: ${String((handshake as {action: string}).action)}`);
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
