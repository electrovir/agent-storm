import {type PaneKind, type PaneStatus} from '@agent-storm/common';
import {Buffer} from 'node:buffer';

export enum FrameType {
    Data = 0,
    Control = 1,
}

const headerSize = 5;

function encodeFrame(type: FrameType, payload: Buffer): Buffer {
    const header = Buffer.alloc(headerSize);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([
        header,
        payload,
    ]);
}

export function encodeControlFrame(message: unknown): Buffer {
    return encodeFrame(FrameType.Control, Buffer.from(JSON.stringify(message)));
}

export function encodeDataFrame(data: string | Buffer): Buffer {
    const payload = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    return encodeFrame(FrameType.Data, payload);
}

export type ParsedFrame = {
    type: FrameType;
    payload: Buffer;
};

/**
 * Stateful decoder that accumulates byte chunks and emits complete frames as they arrive. Buffers
 * are mutated in place because this sits on a hot socket-read path.
 */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    public push(chunk: Buffer): ParsedFrame[] {
        this.buffer = Buffer.concat([
            this.buffer,
            chunk,
        ]);
        const frames: ParsedFrame[] = [];
        while (this.buffer.length >= headerSize) {
            const type = this.buffer.readUInt8(0) as FrameType;
            const length = this.buffer.readUInt32BE(1);
            if (this.buffer.length < headerSize + length) {
                break;
            }
            const payload = Buffer.from(this.buffer.subarray(headerSize, headerSize + length));
            frames.push({
                type,
                payload,
            });
            this.buffer = this.buffer.subarray(headerSize + length);
        }
        return frames;
    }
}

export enum DaemonAction {
    Attach = 'attach',
    Status = 'status',
    Restart = 'restart',
    Kill = 'kill',
    Shutdown = 'shutdown',
    VscodeEnsure = 'vscode-ensure',
    VscodeKill = 'vscode-kill',
    VscodeList = 'vscode-list',
}

export type AttachHandshake = {
    action: DaemonAction.Attach;
    folder: string;
    kind: PaneKind;
    /**
     * Command to invoke for `PaneKind.Ai` when the daemon spawns the PTY for the first time. Sent
     * on every attach because the daemon doesn't read agent-storm's config file — the backend does,
     * and forwards the current value so config edits to `aiCmd` take effect on the next pane spawn
     * (existing live PTYs keep their old command until restarted).
     */
    aiCmd?: string | undefined;
};

export type StatusHandshake = {
    action: DaemonAction.Status;
};

export type RestartHandshake = {
    action: DaemonAction.Restart;
    folder: string;
    kind: PaneKind;
    /** See {@link AttachHandshake.aiCmd} — same plumbing, applied to the restart spawn. */
    aiCmd?: string | undefined;
};

export type KillHandshake = {
    action: DaemonAction.Kill;
    folder: string;
};

export type ShutdownHandshake = {
    action: DaemonAction.Shutdown;
};

export type VscodeEnsureHandshake = {
    action: DaemonAction.VscodeEnsure;
    folder: string;
    /**
     * Path prefix that the backend's reverse proxy will mount the VS Code server under. The daemon
     * passes this to `code serve-web` via `--server-base-path` so the asset URLs in the served HTML
     * resolve correctly through the proxy. Empty string disables the base path.
     */
    basePath: string;
};

export type VscodeKillHandshake = {
    action: DaemonAction.VscodeKill;
    folder: string;
};

export type VscodeListHandshake = {
    action: DaemonAction.VscodeList;
};

export type ClientHandshake =
    | AttachHandshake
    | StatusHandshake
    | RestartHandshake
    | KillHandshake
    | ShutdownHandshake
    | VscodeEnsureHandshake
    | VscodeKillHandshake
    | VscodeListHandshake;

export type StatusEntry = {
    folder: string;
    kind: PaneKind;
    status: PaneStatus;
};

export type AttachResponse = {
    ok: true;
    isNew: boolean;
};

export type StatusResponse = {
    ok: true;
    panes: StatusEntry[];
};

export type SimpleResponse = {
    ok: true;
};

export type VscodeEnsureResponse = {
    ok: true;
    port: number;
};

export type VscodeListEntry = {
    folder: string;
    port: number;
    basePath: string;
};

export type VscodeListResponse = {
    ok: true;
    instances: VscodeListEntry[];
};

export type ErrorResponse = {
    ok: false;
    error: string;
};

export type ExitNotification = {
    type: 'exit';
    exitCode: number | undefined;
};

/**
 * Sent from a daemon-client to the daemon over an already-attached socket. The daemon forwards the
 * dimensions to the underlying PTY so the spawned shell wraps at the right column.
 */
export type ResizeNotification = {
    type: 'resize';
    cols: number;
    rows: number;
};
