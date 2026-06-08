import {PaneKind, PaneStatus} from '@agent-storm/common';
import {getObjectTypedKeys, omitObjectKeys} from '@augment-vir/common';
import {spawn, type IPty} from 'node-pty';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {killProcessTree} from './kill-process-tree.js';
import type {StatusEntry} from './protocol.js';

const idleThresholdMs = 2000;

/**
 * Fallback AI command when the backend doesn't supply one via the attach handshake. The
 * `AGENT_STORM_AI_CMD` env var is still honored as a last resort for direct daemon-protocol callers
 * that don't go through the backend (mostly debugging / tests). Production calls always carry the
 * current config's `aiCmd` and so override this.
 */
const fallbackAiCommand = process.env.AGENT_STORM_AI_CMD || 'claude';

/**
 * Build the argv for a fresh PTY. AI pane runs through a login + interactive shell so `.zprofile` /
 * `.zshrc` get sourced (those are where managed-Claude installers usually inject their PATH lines).
 * When the AI command exits the wrapper shell terminates with it — the pane lands in `Exited` state
 * so the user can read whatever the AI command printed without it being clobbered by a new shell
 * prompt. Restart via the row's menu when ready to start a fresh session.
 */
function buildPaneCommand(kind: PaneKind, aiCmd: string): string[] {
    const shell = process.env.SHELL || '/bin/bash';
    if (kind === PaneKind.Ai) {
        return [
            shell,
            '-lic',
            aiCmd,
        ];
    }
    return [
        shell,
        '-l',
    ];
}

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
    spawnGeneration: number;
    lastOutputAt: number;
    exitCode: number | undefined;
    subscribers: Set<Subscriber>;
    /** Bounded scrollback used to replay output to a newly attaching client. */
    scrollbackChunks: string[];
    scrollbackBytes: number;
};

/** Bounded replay buffer per pane for newly attached browser terminals. */
const maxScrollbackBytes = 10_000_000;

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
        spawnGeneration: 0,
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
 * Build the env we hand to a freshly spawned shell. Strips:
 *
 * - From `PATH`, only the npm-injected `node_modules/.bin` entries (because `npm start` was the
 *   daemon's grandparent and npm prepends every ancestor `node_modules/.bin` to PATH). The rest of
 *   PATH is preserved verbatim. Previously we dropped PATH entirely and relied on `/etc/zprofile`'s
 *   `path_helper` to rebuild it during shell startup, but that rebuild only produces the
 *   `/etc/paths` + `/etc/paths.d/*` defaults — it loses every PATH entry the user inherited from
 *   launchd / their terminal app (e.g. `~/.claude/local`, Homebrew on Apple silicon,
 *   manually-managed bin dirs). Aliases like `claude=~/.claude/local/claude` still worked because
 *   the alias supplies a full path, but `command claude` (which bypasses aliases and goes through
 *   `PATH` lookup) couldn't find the binary, so "Restart AI session" silently no-op'd even though
 *   the user's raw terminal could run the exact same string.
 * - `BACKEND_PORT` / `FRONTEND_PORT` because those are internal agent-storm orchestration env vars
 *   set in `packages/scripts/src/start.script.ts`. They have no business leaking into the user's
 *   shell — a `claude` session that inspects `env` would otherwise see them and could be tricked
 *   into talking to the backend, and any subshell the user starts would inherit them too.
 * - Every `npm_*` var (`npm_config_*`, `npm_lifecycle_*`, `npm_package_*`, `npm_execpath`, …). npm
 *   exports its entire resolved config to child processes, so because the daemon was launched via
 *   `npm exec` / `npx`, those vars are frozen into the daemon's environment — including
 *   `npm_config_prefix`, which pins the global-install location to whichever node version was
 *   active at daemon start. Inheriting them makes `npm i -g` inside a spawned shell write to that
 *   frozen prefix regardless of the shell's current `nvm`-selected node, so `npm -v` never reflects
 *   the install. A real terminal started from the OS has none of these, so neither should ours.
 */
function spawnEnv(): NodeJS.ProcessEnv {
    const npmInjectedKeys = getObjectTypedKeys(process.env).filter((key) =>
        String(key).toLowerCase().startsWith('npm_'),
    );
    const base = omitObjectKeys(process.env, [
        'BACKEND_PORT',
        'FRONTEND_PORT',
        ...npmInjectedKeys,
    ]);
    /**
     * Drop entries the npm CLI prepends when running a script (every ancestor `<repo>/node_modules/
     * .bin`). Keep everything else so user-customized PATH additions inherited from launchd /
     * Terminal.app survive into the spawned shell.
     */
    const cleanedPath = process.env.PATH?.split(':')
        .filter((entry) => !entry.endsWith('/node_modules/.bin'))
        .join(':');
    return cleanedPath
        ? {
              ...base,
              PATH: cleanedPath,
          }
        : base;
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

function startPty(folder: string, kind: PaneKind, entry: PaneEntry, aiCmd: string): void {
    entry.spawnGeneration += 1;
    const spawnGeneration = entry.spawnGeneration;
    const [
        command,
        ...args
    ] = buildPaneCommand(kind, aiCmd);
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
            if (entry.spawnGeneration !== spawnGeneration) {
                return;
            }
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
    aiCmd,
    onData,
    onExit,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    /**
     * Current `aiCmd` from agent-storm config. Used only when spawning a fresh AI PTY here —
     * existing live PTYs continue running whatever command they were launched with until the user
     * explicitly restarts the pane. Falls back to {@link fallbackAiCommand} when omitted.
     */
    aiCmd?: string | undefined;
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
        startPty(folder, kind, entry, aiCmd || fallbackAiCommand);
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

export function restartPane({
    folder,
    kind,
    aiCmd,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    aiCmd?: string | undefined;
}>): void {
    const entry = ensureEntry(folder, kind);
    if (entry.pty) {
        killProcessTree(entry.pty.pid);
    }
    entry.pty = undefined;
    entry.exitCode = undefined;
    clearScrollback(entry);
    startPty(folder, kind, entry, aiCmd || fallbackAiCommand);
}

export function killFolderPanes({folder}: Readonly<{folder: string}>): void {
    Object.values(PaneKind).forEach((kind) => {
        const key = paneKey(folder, kind);
        const entry = panes.get(key);
        if (entry?.pty) {
            killProcessTree(entry.pty.pid);
            entry.pty = undefined;
        }
        panes.delete(key);
    });
}

/**
 * Synchronously tear down every pane's process tree. Used on daemon shutdown, where the event loop
 * is about to stop and the deferred SIGKILL backstop in {@link killProcessTree} would never fire, so
 * the kill must be immediate.
 */
export function killAllPanes(): void {
    panes.forEach((entry) => {
        if (entry.pty) {
            killProcessTree(entry.pty.pid, {
                immediate: true,
            });
            entry.pty = undefined;
        }
    });
    panes.clear();
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
