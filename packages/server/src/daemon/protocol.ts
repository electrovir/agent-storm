import {type PaneKind, type PaneStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
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
    protected buffer: Buffer = Buffer.alloc(0);

    public push(chunk: Buffer): ParsedFrame[] {
        this.buffer = Buffer.concat([
            this.buffer,
            chunk,
        ]);
        const frames: ParsedFrame[] = [];
        while (this.buffer.length >= headerSize) {
            const type = this.buffer.readUInt8(0);
            const length = this.buffer.readUInt32BE(1);
            if (this.buffer.length < headerSize + length) {
                break;
            }
            if (check.isEnumValue(type, FrameType)) {
                const payload = Buffer.from(this.buffer.subarray(headerSize, headerSize + length));
                frames.push({
                    type,
                    payload,
                });
            }
            this.buffer = this.buffer.subarray(headerSize + length);
        }
        return frames;
    }
}

/**
 * Bumped whenever the daemon's wire contract changes in a way a mismatched backend can't tolerate.
 * Version 2 introduced `sessionId` on the pane key; a version-1 daemon silently ignores the field
 * and collapses every session of a folder+kind onto one PTY, so `ensureDaemon` restarts any daemon
 * that doesn't report at least this value. Version 4 answers a pty's OSC 10 / 11 color queries from
 * {@link TerminalColors}; an earlier daemon leaves them unanswered, which silently costs codex the
 * gray background behind its prompt. Version 3 was that same feature mid-landing — it declared the
 * colors on the wire without answering anything — so the gate has to reject it too.
 *
 * The version is reported on {@link StatusResponse} rather than through a dedicated action because
 * `Status` is the only introspection action every historical daemon understands — see
 * {@link DaemonAction.Shutdown} for why probing with a new action would be destructive.
 */
export const daemonProtocolVersion = 4;

export enum DaemonAction {
    Attach = 'attach',
    Status = 'status',
    Restart = 'restart',
    Kill = 'kill',
    /**
     * Kills one session's PTY, leaving its siblings in the same folder+kind alive. Unknown to
     * version-1 daemons, which is precisely why the version check must gate on `Status` first.
     */
    SessionKill = 'session-kill',
    Shutdown = 'shutdown',
}

/**
 * Id given to the first session of every folder+kind, and the value an empty/absent `sessionId`
 * resolves to. Shared between the daemon's pane pool and the backend's session store on purpose: if
 * the store minted a generated id for session 1 while the pool defaulted to something else, a
 * client that sent no `sessionId` would land on a second PTY that no tab points at — an invisible
 * session burning CPU.
 */
export const defaultSessionId = 'default';

/**
 * Identifies one session tab within a folder's pane. Empty resolves to the folder+kind's first
 * session, which keeps pre-multi-session callers (and any client that hasn't loaded its session
 * list yet) attaching to the same PTY they always did.
 */
export type SessionKeyFields = {
    folder: string;
    kind: PaneKind;
    sessionId?: string | undefined;
};

/**
 * A terminal's default foreground and background, each six hex digits with no leading `#`. The
 * daemon holds them so it can answer a pty's OSC 10 / 11 color queries itself — see
 * `answerColorQueries` in `pty-pool.ts` for why the browser can't answer them in time.
 */
export type TerminalColors = {
    foreground: string;
    background: string;
};

export type AttachHandshake = {
    action: DaemonAction.Attach;
    folder: string;
    kind: PaneKind;
    /** See {@link SessionKeyFields.sessionId}. */
    sessionId?: string | undefined;
    /**
     * Palette the attaching client renders with. Sent on every attach, so re-attaching after a
     * light ↔ dark flip is enough to correct the answer even without {@link ColorsNotification}.
     */
    colors?: TerminalColors | undefined;
    /**
     * Command to invoke for `PaneKind.Ai` when the daemon spawns the PTY for the first time. Sent
     * on every attach because the daemon doesn't read agent-storm's config file — the backend does,
     * and forwards the current value so config edits to `aiCmd` take effect on the next pane spawn
     * (existing live PTYs keep their old command until restarted).
     */
    aiCmd?: string | undefined;
    /**
     * Set as `AGENT_STORM_CONVERSATION_ID` in a freshly spawned PTY's environment. Daemons older
     * than this field ignore it, which only means their panes go without the variable.
     */
    conversationId?: string | undefined;
    /**
     * Max scrollback lines to replay to this client on attach. When set, the daemon truncates the
     * pane's buffered scrollback to the last N lines before sending it. Omitted means replay the
     * full buffered scrollback.
     */
    scrollbackLimit?: number | undefined;
};

export type StatusHandshake = {
    action: DaemonAction.Status;
};

export type RestartHandshake = {
    action: DaemonAction.Restart;
    folder: string;
    kind: PaneKind;
    /** See {@link SessionKeyFields.sessionId}. */
    sessionId?: string | undefined;
    /** See {@link AttachHandshake.aiCmd} — same plumbing, applied to the restart spawn. */
    aiCmd?: string | undefined;
    /** See {@link AttachHandshake.conversationId}. */
    conversationId?: string | undefined;
};

/** Kills every session of every kind under `folder`. */
export type KillHandshake = {
    action: DaemonAction.Kill;
    folder: string;
};

export type SessionKillHandshake = {
    action: DaemonAction.SessionKill;
    folder: string;
    kind: PaneKind;
    sessionId: string;
};

export type ShutdownHandshake = {
    action: DaemonAction.Shutdown;
};

export type ClientHandshake =
    | AttachHandshake
    | StatusHandshake
    | RestartHandshake
    | KillHandshake
    | SessionKillHandshake
    | ShutdownHandshake;

export type StatusEntry = {
    folder: string;
    kind: PaneKind;
    /** Absent when reported by a version-1 daemon, which had no concept of sessions. */
    sessionId?: string | undefined;
    status: PaneStatus;
};

export type AttachResponse = {
    ok: true;
    isNew: boolean;
    /**
     * Whether a PTY is alive for this pane now that the attach is done. Absent from version-1
     * daemons, which reported nothing about spawn failures; callers treat that as "running" since
     * that was the old assumption.
     */
    isRunning?: boolean | undefined;
};

export type StatusResponse = {
    ok: true;
    panes: StatusEntry[];
    /**
     * Absent from version-1 daemons. {@link daemonProtocolVersion} explains why the version travels
     * on this response instead of its own action.
     */
    protocolVersion?: number | undefined;
};

export type SimpleResponse = {
    ok: true;
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

/**
 * Sent from a daemon-client to the daemon over an already-attached socket when the client's palette
 * changes. The socket outlives a light ↔ dark flip, so without this the daemon would keep answering
 * color queries with the mode the pane was opened in.
 */
export type ColorsNotification = {
    type: 'colors';
    colors: TerminalColors;
};

/** Every control frame a daemon-client may send over an already-attached socket. */
export type AttachedNotification = ResizeNotification | ColorsNotification;
