import {type PaneKind} from '@agent-storm/common';
import {wrapPromiseInTimeout} from '@augment-vir/common';
import {type AnyDuration} from 'date-vir';
import {createConnection, type Socket} from 'node:net';
import {daemonSocket} from '../file-paths.js';
import {
    DaemonAction,
    encodeControlFrame,
    encodeDataFrame,
    FrameDecoder,
    FrameType,
    type AttachResponse,
    type ClientHandshake,
    type ColorsNotification,
    type ErrorResponse,
    type ExitNotification,
    type ResizeNotification,
    type SimpleResponse,
    type StatusEntry,
    type StatusResponse,
    type TerminalColors,
    type VerifyLaunchResponse,
} from './protocol.js';

function connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(daemonSocket.path);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

/**
 * How long the daemon gets to answer a handshake. It answers every action synchronously, so running
 * past this means it is wedged, and waiting longer would only hang whatever request is waiting on
 * it.
 */
const daemonReplyTimeout: AnyDuration = {
    seconds: 10,
};

/**
 * Sends `handshake` over an already-connected `socket` and resolves with the daemon's first control
 * frame. Rejects on an error reply, when the socket closes first, or past `timeout`. The socket is
 * destroyed either way, since every action but `Attach` gets exactly one reply.
 */
export async function requestDaemonReply<Response extends {ok: true}>({
    socket,
    handshake,
    timeout,
}: Readonly<{
    socket: Socket;
    handshake: Readonly<ClientHandshake>;
    timeout: Readonly<AnyDuration>;
}>) {
    const decoder = new FrameDecoder();
    try {
        return await wrapPromiseInTimeout(
            timeout,
            new Promise<Response>((resolve, reject) => {
                socket.on('data', (chunk) => {
                    const controlFrame = decoder
                        .push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
                        .find((frame) => frame.type === FrameType.Control);
                    if (!controlFrame) {
                        return;
                    }
                    const parsed = JSON.parse(controlFrame.payload.toString('utf-8')) as
                        | Response
                        | ErrorResponse;
                    if (parsed.ok) {
                        resolve(parsed);
                    } else {
                        reject(new Error(parsed.error));
                    }
                });
                socket.once('error', reject);
                socket.once('close', () => {
                    reject(
                        new Error(
                            `PTY daemon closed the socket before answering ${handshake.action}.`,
                        ),
                    );
                });
                socket.write(encodeControlFrame(handshake));
            }),
            `PTY daemon did not answer ${handshake.action}`,
        );
    } finally {
        socket.destroy();
    }
}

async function singleShot<Response extends {ok: true}>(handshake: Readonly<ClientHandshake>) {
    return await requestDaemonReply<Response>({
        socket: await connect(),
        handshake,
        timeout: daemonReplyTimeout,
    });
}

export async function fetchPaneStatuses(): Promise<StatusEntry[]> {
    const response = await singleShot<StatusResponse>({
        action: DaemonAction.Status,
    });
    return response.panes;
}

/**
 * Read the running daemon's wire-contract version. Probes with `Status` because that is the only
 * introspection action every historical daemon understands — a version-1 daemon treats any
 * unrecognized action as "shutdown" and would kill every pane before we learned anything. A daemon
 * that answers without the field is version 1.
 */
export async function fetchDaemonProtocolVersion(): Promise<number> {
    const response = await singleShot<StatusResponse>({
        action: DaemonAction.Status,
    });
    return response.protocolVersion ?? 1;
}

export async function restartPane({
    folder,
    kind,
    sessionId,
    aiCmd,
    conversationId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId?: string | undefined;
    aiCmd?: string | undefined;
    conversationId?: string | undefined;
}>): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Restart,
        folder,
        kind,
        sessionId,
        aiCmd,
        conversationId,
    });
}

export async function killPaneSession({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.SessionKill,
        folder,
        kind,
        sessionId,
    });
}

export async function killFolderPanes({folder}: Readonly<{folder: string}>): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Kill,
        folder,
    });
}

/** Whether `signature` is `payload` signed with the launch key of a running AI tab. */
export async function verifyLaunchSignature({
    conversationId,
    payload,
    signature,
}: Readonly<{
    conversationId: string;
    payload: string;
    signature: string;
}>) {
    const response = await singleShot<VerifyLaunchResponse>({
        action: DaemonAction.VerifyLaunch,
        conversationId,
        payload,
        signature,
    });
    return response.isValid;
}

export async function shutdownDaemon(): Promise<void> {
    await singleShot<SimpleResponse>({
        action: DaemonAction.Shutdown,
    });
}

export type PaneAttachment = Awaited<ReturnType<typeof attachPane>>;

export async function attachPane({
    folder,
    kind,
    sessionId,
    colors,
    aiCmd,
    conversationId,
    scrollbackLimit,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    /** Which session tab to attach to. Empty/omitted resolves to the folder+kind's default. */
    sessionId?: string | undefined;
    /**
     * Palette this client renders with, forwarded to the daemon's attach handshake so it can answer
     * the pty's OSC 10 / 11 color queries.
     */
    colors?: Readonly<TerminalColors> | undefined;
    /**
     * Current `aiCmd` from agent-storm config — forwarded to the daemon's attach handshake so a
     * fresh AI PTY honors the user's configured command rather than whatever was in env when the
     * daemon started.
     */
    aiCmd?: string | undefined;
    /** Set as `AGENT_STORM_CONVERSATION_ID` in the PTY's environment if this attach spawns it. */
    conversationId?: string | undefined;
    /**
     * Client-requested cap on replayed scrollback lines, forwarded to the daemon's attach
     * handshake. The daemon truncates the buffered scrollback to the last N lines before replaying
     * it.
     */
    scrollbackLimit?: number | undefined;
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
}>) {
    const socket = await connect();
    const decoder = new FrameDecoder();

    socket.write(
        encodeControlFrame({
            action: DaemonAction.Attach,
            folder,
            kind,
            sessionId,
            colors,
            aiCmd,
            conversationId,
            scrollbackLimit,
        }),
    );

    const handshakeState = {
        resolved: false,
    };

    const handshakeResult = await wrapPromiseInTimeout(
        daemonReplyTimeout,
        new Promise<AttachResponse>((resolve, reject) => {
            function handler(chunk: Buffer | string) {
                const frames = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                frames.forEach((frame) => {
                    if (handshakeState.resolved) {
                        routeFrame(frame);
                    } else if (frame.type === FrameType.Control) {
                        handshakeState.resolved = true;
                        const parsed = JSON.parse(frame.payload.toString('utf-8')) as
                            | AttachResponse
                            | ErrorResponse;
                        if (parsed.ok) {
                            resolve(parsed);
                        } else {
                            socket.end();
                            reject(new Error(parsed.error));
                        }
                    }
                });
            }
            function routeFrame(frame: {type: FrameType; payload: Buffer}) {
                if (frame.type === FrameType.Data) {
                    onData(frame.payload.toString('utf-8'));
                    return;
                }
                const parsed = JSON.parse(frame.payload.toString('utf-8')) as ExitNotification;
                onExit(parsed.exitCode);
            }
            socket.on('data', handler);
            socket.once('error', reject);
            socket.once('close', () => {
                if (handshakeState.resolved) {
                    onExit(undefined);
                } else {
                    reject(new Error('Daemon socket closed before handshake response.'));
                }
            });
        }),
        'PTY daemon did not answer attach',
    ).catch((error: unknown) => {
        socket.destroy();
        throw error;
    });

    return {
        isNew: handshakeResult.isNew,
        /** See {@link AttachResponse.isRunning}. */
        isRunning: handshakeResult.isRunning ?? true,
        write(data: string) {
            socket.write(encodeDataFrame(data));
        },
        resize({cols, rows}: Readonly<{cols: number; rows: number}>) {
            const notification: ResizeNotification = {
                type: 'resize',
                cols,
                rows,
            };
            socket.write(encodeControlFrame(notification));
        },
        /** See {@link ColorsNotification} for why the palette is re-sent on an open socket. */
        setColors(updatedColors: Readonly<TerminalColors>) {
            const notification: ColorsNotification = {
                type: 'colors',
                colors: updatedColors,
            };
            socket.write(encodeControlFrame(notification));
        },
        close() {
            socket.end();
        },
    };
}
