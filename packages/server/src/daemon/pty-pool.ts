import {PaneKind, PaneStatus} from '@agent-storm/common';
import {spawn, type IPty} from 'node-pty';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import type {StatusEntry} from './protocol.js';

const idleThresholdMs = 2_000;

const aiCommand = process.env.AGENT_STORM_AI_CMD || 'claude';

/**
 * Run the AI command through a login + interactive shell. The `-l` flag is what matters here:
 * the managed Claude installer (and many tools) add their PATH lines to `.zprofile`, which only
 * runs in login shells. Without `-l`, even an interactive `zsh -ic` misses those additions and
 * resolves to a different `claude` binary than your TUI / Terminal.app would.
 */
const paneCommands: Record<PaneKind, () => string[]> = {
    [PaneKind.Ai]: () => [
        process.env.SHELL || '/bin/zsh',
        '-lic',
        aiCommand,
    ],
    [PaneKind.Shell]: () => [
        process.env.SHELL || '/bin/zsh',
        '-l',
    ],
};

type PaneEntry = {
    pty: IPty | undefined;
    lastOutputAt: number;
    exitCode: number | undefined;
    subscribers: Set<(data: string) => void>;
    exitSubscribers: Set<(exitCode: number | undefined) => void>;
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
        exitSubscribers: new Set(),
        scrollbackChunks: [],
        scrollbackBytes: 0,
    };
    panes.set(key, entry);
    return entry;
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
        });
        entry.pty = pty;
        entry.exitCode = undefined;
        entry.lastOutputAt = Date.now();
        pty.onData((data) => {
            entry.lastOutputAt = Date.now();
            appendScrollback(entry, data);
            entry.subscribers.forEach((subscriber) => {
                subscriber(data);
            });
        });
        pty.onExit(({exitCode}) => {
            entry.exitCode = exitCode;
            entry.pty = undefined;
            const message = `[pty ${kind} for ${folder} exited with code ${exitCode}]\r\n`;
            appendScrollback(entry, message);
            entry.subscribers.forEach((subscriber) => {
                subscriber(message);
            });
            entry.exitSubscribers.forEach((subscriber) => {
                subscriber(exitCode);
            });
        });
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message = `[pty ${kind} failed to spawn: ${reason}]\r\n`;
        entry.exitCode = -1;
        appendScrollback(entry, message);
        entry.subscribers.forEach((subscriber) => {
            subscriber(message);
        });
        entry.exitSubscribers.forEach((subscriber) => {
            subscriber(-1);
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
}>): {isNew: boolean; scrollback: string; detach: () => void} {
    const entry = ensureEntry(folder, kind);
    const isNew = !entry.pty;
    if (!entry.pty) {
        startPty(folder, kind, entry);
    }
    entry.subscribers.add(onData);
    entry.exitSubscribers.add(onExit);
    const scrollback = entry.scrollbackChunks.join('');
    return {
        isNew,
        scrollback,
        detach() {
            entry.subscribers.delete(onData);
            entry.exitSubscribers.delete(onExit);
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
    }
    if (!entry.pty) {
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
