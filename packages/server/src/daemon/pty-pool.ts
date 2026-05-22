import {PaneKind, PaneStatus} from '@agent-storm/common';
import {omitObjectKeys} from '@augment-vir/common';
import {spawn, type IPty} from 'node-pty';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import type {StatusEntry} from './protocol.js';

const idleThresholdMs = 2000;

const aiCommand = process.env.AGENT_STORM_AI_CMD || 'claude';

/**
 * AI pane runs through a login + interactive shell so `.zprofile` / `.zshrc` get sourced (those are
 * where managed-Claude installers usually inject their PATH lines). When the AI command exits (user
 * typed `/exit`, ran a one-shot, crashed, etc.) the trailing `exec <shell> -li` replaces the
 * wrapper with another login+interactive copy of the user's preferred shell, so the pty stays alive
 * and the user lands in a normal shell prompt instead of an `[exited with code …]` dead pane.
 */
const paneCommands: Record<PaneKind, () => string[]> = {
    [PaneKind.Ai]: () => {
        const shell = process.env.SHELL || '/bin/bash';
        return [
            shell,
            '-lic',
            `${aiCommand}; exec ${shell} -li`,
        ];
    },
    [PaneKind.Shell]: () => [
        process.env.SHELL || '/bin/bash',
        '-l',
    ],
};

type PaneSize = {
    cols: number;
    rows: number;
};

type Subscriber = {
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
    /**
     * Most-recent viewport size reported by this client. Undefined until the client sends its first
     * resize. Used to compute the pane-wide min size below.
     */
    size: PaneSize | undefined;
};

type PaneEntry = {
    pty: IPty | undefined;
    lastOutputAt: number;
    exitCode: number | undefined;
    subscribers: Set<Subscriber>;
    /** Bounded scrollback used to replay output to a newly attaching client. */
    scrollbackChunks: string[];
    scrollbackBytes: number;
};

/** Roughly 1 MB of scrollback per pane, which is several thousand lines of typical output. */
const maxScrollbackBytes = 1_000_000;

function appendScrollback(entry: PaneEntry, data: string): void {
    entry.scrollbackChunks.push(data);
    entry.scrollbackBytes += data.length;
    while (entry.scrollbackBytes > maxScrollbackBytes && entry.scrollbackChunks.length > 1) {
        const dropped = entry.scrollbackChunks.shift();
        if (dropped) {
            entry.scrollbackBytes -= dropped.length;
        }
    }
}

function clearScrollback(entry: PaneEntry): void {
    entry.scrollbackChunks = [];
    entry.scrollbackBytes = 0;
}

const panes = new Map<string, PaneEntry>();

function normalizePath(path: string): string {
    const expanded =
        path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    return resolve(expanded);
}

function paneKey(folder: string, kind: PaneKind): string {
    return `${folder}:${kind}`;
}

function ensureEntry(folder: string, kind: PaneKind): PaneEntry {
    const key = paneKey(folder, kind);
    const existing = panes.get(key);
    if (existing) {
        return existing;
    }
    const entry: PaneEntry = {
        pty: undefined,
        lastOutputAt: 0,
        exitCode: undefined,
        subscribers: new Set(),
        scrollbackChunks: [],
        scrollbackBytes: 0,
    };
    panes.set(key, entry);
    return entry;
}

/**
 * Build the env we hand to a freshly spawned shell. Critically, we DROP `PATH` so the spawned
 * login+interactive shell rebuilds it from /etc/paths and the user's rc files — exactly the way
 * Terminal.app does. Inheriting `PATH` from the daemon process pollutes the start with npm-injected
 * `node_modules/.bin` entries (because `npm start` was the daemon's grandparent), which push the
 * user's `.zprofile` PATH prepends into late positions and can mask the preferred copy of `claude`
 * (or any other binary they expect to find first).
 */
function spawnEnv(): NodeJS.ProcessEnv {
    return omitObjectKeys(process.env, ['PATH']);
}

/**
 * Compute the smallest viewport across all currently-attached subscribers and resize the PTY to
 * match. Subscribers that haven't reported a size yet are skipped. When no subscriber has a size,
 * the pty keeps whatever dimensions it had (either the spawn default or the last applied min); this
 * matters mostly during the brief window between a new socket attaching and its first resize
 * message arriving.
 */
function applyMinSize(entry: PaneEntry): void {
    if (!entry.pty) {
        return;
    }
    const sizes = Array.from(entry.subscribers, (subscriber) => subscriber.size).filter(
        (size): size is PaneSize => size !== undefined,
    );
    if (sizes.length === 0) {
        return;
    }
    const cols = sizes.reduce((min, size) => Math.min(min, size.cols), Number.POSITIVE_INFINITY);
    const rows = sizes.reduce((min, size) => Math.min(min, size.rows), Number.POSITIVE_INFINITY);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
        entry.pty.resize(cols, rows);
    }
}

function startPty(folder: string, kind: PaneKind, entry: PaneEntry): void {
    const [
        command,
        ...args
    ] = paneCommands[kind]();
    if (!command) {
        return;
    }
    const cwd = normalizePath(folder);
    try {
        const pty = spawn(command, args, {
            name: 'xterm-256color',
            cols: 120,
            rows: 32,
            cwd,
            env: spawnEnv() as Record<string, string>,
        });
        entry.pty = pty;
        entry.exitCode = undefined;
        entry.lastOutputAt = Date.now();
        pty.onData((data) => {
            entry.lastOutputAt = Date.now();
            appendScrollback(entry, data);
            entry.subscribers.forEach((subscriber) => {
                subscriber.onData(data);
            });
        });
        pty.onExit(({exitCode}) => {
            entry.exitCode = exitCode;
            entry.pty = undefined;
            const message = `[pty ${kind} for ${folder} exited with code ${exitCode}]\r\n`;
            appendScrollback(entry, message);
            entry.subscribers.forEach((subscriber) => {
                subscriber.onData(message);
                subscriber.onExit(exitCode);
            });
        });
        /**
         * If a restart happens while clients are still attached (each carrying their last reported
         * size), pull the fresh pty down to the existing min before any data flows.
         */
        applyMinSize(entry);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `[pty ${kind} failed to spawn: ${reason}]\r\n`;
        entry.exitCode = -1;
        appendScrollback(entry, message);
        entry.subscribers.forEach((subscriber) => {
            subscriber.onData(message);
            subscriber.onExit(-1);
        });
    }
}

export function attachPane({
    folder,
    kind,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    onData: (data: string) => void;
    onExit: (exitCode: number | undefined) => void;
}>): {
    isNew: boolean;
    scrollback: string;
    setSize: (cols: number, rows: number) => void;
    detach: () => void;
} {
    const entry = ensureEntry(folder, kind);
    const isNew = !entry.pty;
    if (!entry.pty) {
        startPty(folder, kind, entry);
    }
    const subscriber: Subscriber = {
        onData,
        onExit,
        size: undefined,
    };
    entry.subscribers.add(subscriber);
    const scrollback = entry.scrollbackChunks.join('');
    return {
        isNew,
        scrollback,
        setSize(cols, rows) {
            if (cols < 1 || rows < 1) {
                return;
            }
            subscriber.size = {
                cols,
                rows,
            };
            applyMinSize(entry);
        },
        detach() {
            entry.subscribers.delete(subscriber);
            /**
             * Detaching may have removed the smallest viewport — recompute so the pty grows back up
             * to whatever the remaining clients allow.
             */
            applyMinSize(entry);
        },
    };
}

export function writeToPane({
    folder,
    kind,
    data,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    data: string;
}>): void {
    const entry = panes.get(paneKey(folder, kind));
    entry?.pty?.write(data);
}

export function restartPane({folder, kind}: Readonly<{folder: string; kind: PaneKind}>): void {
    const entry = ensureEntry(folder, kind);
    entry.pty?.kill();
    entry.pty = undefined;
    entry.exitCode = undefined;
    clearScrollback(entry);
    startPty(folder, kind, entry);
}

export function killFolderPanes({folder}: Readonly<{folder: string}>): void {
    Object.values(PaneKind).forEach((kind) => {
        const key = paneKey(folder, kind);
        const entry = panes.get(key);
        if (entry?.pty) {
            entry.pty.kill();
            entry.pty = undefined;
        }
        panes.delete(key);
    });
}

function entryStatus(entry: PaneEntry | undefined): PaneStatus {
    if (!entry) {
        return PaneStatus.None;
    } else if (!entry.pty) {
        return entry.exitCode == undefined ? PaneStatus.None : PaneStatus.Exited;
    }
    return Date.now() - entry.lastOutputAt < idleThresholdMs ? PaneStatus.Busy : PaneStatus.Idle;
}

export function listAllPaneStatuses(): StatusEntry[] {
    return Array.from(panes.entries()).map(
        ([
            key,
            entry,
        ]) => {
            const separator = key.lastIndexOf(':');
            return {
                folder: key.slice(0, separator),
                kind: key.slice(separator + 1) as PaneKind,
                status: entryStatus(entry),
            };
        },
    );
}
