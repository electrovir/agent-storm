import {PaneKind} from '@agent-storm/common';
import {createConnection, type Socket} from 'node:net';
import {daemonSocketPath} from './daemon-paths.js';
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
    type ResizeNotification,
    type SimpleResponse,
    type StatusEntry,
    type StatusResponse,
} from './protocol.js';

function connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(daemonSocketPath);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

async function singleShot<Response extends {ok: true}>(
    handshake: ClientHandshake,
): Promise<Response> {
    const socket = await connect();
    const decoder = new FrameDecoder();
    return new Promise<Response>((resolve, reject) => {
        socket.on('data', (chunk) => {
            const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const controlFrame = frames.find((frame) => frame.type === FrameType.Control);
            if (!controlFrame) {
                return;
            }
            const parsed = JSON.parse(controlFrame.payload.toString('utf-8')) as
                | Response
                | ErrorResponse;
            if (!parsed.ok) {
                reject(new Error(parsed.error));
            } else {
                resolve(parsed);
            }
            socket.end();
        });
        socket.on('error', reject);
        socket.write(encodeControlFrame(handshake));
    });
}

export async function fetchPaneStatuses(): Promise<StatusEntry[]> {
    const response = await singleShot<StatusResponse>({
        action: DaemonAction.Status,
    });
    return response.panes;
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Restart,
        folder: params.folder,
        kind: params.kind,
    });
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Kill,
        folder: params.folder,
    });
}

export async function shutdownDaemon(): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Shutdown,
    });
}

export type PaneAttachment = {
    isNew: boolean;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
};

export async function attachPane({
    folder,
    kind,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
}>): Promise<PaneAttachment> {
    const socket = await connect();
    const decoder = new FrameDecoder();

    socket.write(
        encodeControlFrame({
            action: DaemonAction.Attach,
            folder,
            kind,
        }),
    );

    const handshakeState = {
        resolved: false,
    };

    const handshakeResult = await new Promise<AttachResponse>((resolve, reject) => {
        const handler = (chunk: Buffer | string) => {
            const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            frames.forEach((frame) => {
                if (handshakeState.resolved) {
                    routeFrame(frame);
                    return;
                }
                if (frame.type === FrameType.Control) {
                    handshakeState.resolved = true;
                    const parsed = JSON.parse(frame.payload.toString('utf-8')) as
                        | AttachResponse
                        | ErrorResponse;
                    if (!parsed.ok) {
                        socket.end();
                        reject(new Error(parsed.error));
                    } else {
                        resolve(parsed);
                    }
                    return;
                }
                if (handshakeState.resolved && frame.type === FrameType.Data) {
                    onData(frame.payload.toString('utf-8'));
                }
            });
        };
        const routeFrame = (frame: {type: FrameType; payload: Buffer}) => {
            if (frame.type === FrameType.Data) {
                onData(frame.payload.toString('utf-8'));
                return;
            }
            if (frame.type === FrameType.Control) {
                const parsed = JSON.parse(frame.payload.toString('utf-8')) as ExitNotification;
                if (parsed.type === 'exit') {
                    onExit(parsed.exitCode);
                }
            }
        };
        socket.on('data', handler);
        socket.once('error', reject);
        socket.once('close', () => {
            if (!handshakeState.resolved) {
                reject(new Error('Daemon socket closed before handshake response.'));
            } else {
                onExit(undefined);
            }
        });
    });

    return {
        isNew: handshakeResult.isNew,
        write(data) {
            socket.write(encodeDataFrame(data));
        },
        resize(cols, rows) {
            const notification: ResizeNotification = {
                type: 'resize',
                cols,
                rows,
            };
            socket.write(encodeControlFrame(notification));
        },
        close() {
            socket.end();
        },
    };
}
