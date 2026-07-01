import {PaneKind, PaneStatus} from '@agent-storm/common';
import {getObjectTypedKeys, omitObjectKeys} from '@augment-vir/common';
import {spawn, type IPty} from 'node-pty';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, join, resolve} from 'node:path';
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
 * Characters in Claude's TUI whose per-character count changing between polls signals "Claude
 * is rendering something right now". Each one is tracked independently — a change in ANY of
 * the per-character counters re-arms the busy hold. Picked because they appear in Claude's
 * spinner / status frames but are rare in plain user input (typing into the prompt without
 * submitting doesn't move them). Add or remove markers here as Claude's TUI evolves; each
 * marker must be a single UTF-16 code unit (which covers everything in the Unicode BMP,
 * including the symbols below) so `String#split(marker)` counts occurrences correctly.
 */
const aiBusyMarkerChars: ReadonlyArray<string> = [
    '✻', // U+273B teardrop-spoked asterisk
    '✽', // U+273D heavy teardrop-spoked asterisk
    '✶', // U+2736 six-pointed black star
    '✳', // U+2733 eight-spoked asterisk
    '✢', // U+2722 four-teardrop / balloon-spoked asterisk
];

/**
 * After we detect that any AI busy-marker count moved, the pane stays Busy for this long even
 * if no further change is seen. Sized at 4s rather than tied tightly to the 1s poll cadence so
 * a single-poll blip (a quiet tool-result wait, a paused spinner) doesn't flap the sidebar back
 * to "needs attention" — only ~4s of true silence drops the pane to Idle. The 1s poll then
 * keeps this responsive: as soon as Claude renders another marker, the hold extends by another
 * 4s.
 */
const aiBusyHoldMs = 4_000;

/**
 * RFC 4122 DNS namespace UUID. Combined with the worktree's absolute path via UUIDv5, this gives
 * us a stable session ID per worktree — the same path always hashes to the same UUID, so the AI
 * pane can be relaunched with `--resume <uuid>` after an app restart and pick up exactly where it
 * left off.
 */
const claudeSessionNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function uuidv5(name: string, namespace: string): string {
    const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = createHash('sha1').update(namespaceBytes).update(name).digest();
    const bytes = Buffer.from(hash.subarray(0, 16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5 marker
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Claude stores per-project sessions under `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`.
 * Claude encodes project dirs by replacing both `/` AND `.` with `-` (e.g. `/home/x/app.foo`
 * → `-home-x-app-foo`). Matching that exactly is what lets us decide `--resume` vs `--session-id`
 * correctly for worktrees whose path contains a dot. Checking the file's existence is how we
 * decide whether to `--resume <uuid>` (file already present from a prior run) or `--session-id
 * <uuid>` (first time for this worktree — pin the UUID so the *next* launch can resume it).
 */
function claudeSessionFilePath(folder: string, sessionId: string): string {
    const encoded = folder.replace(/[/.]/g, '-');
    return join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, String.raw`'\''`)}'`;
}

/**
 * Append Claude session-resume flags to the resolved AI command for a worktree so the pane
 * automatically restores its last session across app restarts:
 *   - Deterministic UUIDv5 from the worktree path is the session ID.
 *   - `--resume <uuid>` when Claude's storage already has that session file, otherwise
 *     `--session-id <uuid>` to pin the UUID for next time. This is what makes restart recovery
 *     automatic.
 *   - `--name <basename>` labels the session so the user sees a meaningful entry in Claude's
 *     `/resume` picker (worktree name matches the branch name in this user's setup).
 *
 * Only applied when the command is a bare `claude` invocation — appending Claude flags to a
 * custom or compound command (`printf …; while …; done`, a wrapper script, a different AI CLI)
 * would either be a shell syntax error or pass flags the tool doesn't understand, so those run
 * verbatim.
 */
function withClaudeSession(aiCmd: string, folder: string): string {
    const firstToken = aiCmd.trim().split(/\s+/)[0] ?? '';
    if (basename(firstToken) !== 'claude') {
        return aiCmd;
    }
    const sessionId = uuidv5(folder, claudeSessionNamespace);
    const sessionName = basename(folder);
    const nameArg = `--name ${shellSingleQuote(sessionName)}`;
    const sessionArg = existsSync(claudeSessionFilePath(folder, sessionId))
        ? `--resume ${sessionId}`
        : `--session-id ${sessionId}`;
    return `${aiCmd} ${sessionArg} ${nameArg}`;
}

/**
 * Build the argv for a fresh PTY. AI pane runs through a login + interactive shell so `.zprofile` /
 * `.zshrc` get sourced (those are where managed-Claude installers usually inject their PATH lines).
 * When the AI command exits the wrapper shell terminates with it — the pane lands in `Exited` state
 * so the user can read whatever the AI command printed without it being clobbered by a new shell
 * prompt. Restart via the row's menu when ready to start a fresh session.
 */
function buildPaneCommand(kind: PaneKind, aiCmd: string, folder: string): string[] {
    const shell = process.env.SHELL || '/bin/bash';
    if (kind === PaneKind.Ai) {
        return [
            shell,
            '-lic',
            withClaudeSession(aiCmd, folder),
        ];
    }
    /**
     * Services pane runs `npm start` for the worktree. We launch it through the user's login
     * shell (`-lic 'npm start'`) so PATH and node version managers (nvm/asdf) are sourced —
     * `spawn('npm', …)` directly would inherit only the daemon's PATH, which on systems where
     * node is provided by nvm is empty of `npm` until `.zshrc` loads it in.
     */
    if (kind === PaneKind.Services) {
        return [
            shell,
            '-lic',
            'npm start',
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
    /**
     * Wall-clock of the most recent activity in either direction — pty output OR user input.
     * Counting input is what makes the sidebar flip to "Working" the instant the user starts
     * typing, even before the TUI has had a chance to echo characters back. Used only for the
     * shell pane's busy heuristic; the AI pane uses `asteriskCount` below instead.
     */
    lastActivityAt: number;
    /**
     * Monotonic per-character count of busy-marker occurrences the pty has emitted since
     * spawn. Keyed by the marker string itself (one entry per `aiBusyMarkerChars` value);
     * each count climbs independently as that specific character lands in pty output. The
     * AI Busy check compares each per-marker count against its previous-poll snapshot
     * (`busyMarkerCountsAtLastCheck`) so a change in ANY of the tracked characters triggers
     * the busy hold.
     */
    busyMarkerCounts: Map<string, number>;
    /**
     * `busyMarkerCounts` snapshotted (per-key) at the last `entryStatus` query. A mismatch on
     * any key re-arms `lastBusyMarkerChangeAt`.
     */
    busyMarkerCountsAtLastCheck: Map<string, number>;
    /**
     * Wall-clock of the most recent poll at which any per-marker count changed. The AI pane
     * reports Busy for `aiBusyHoldMs` after this timestamp — that's the "4-second hold", so
     * a single-poll quiet spell mid-turn doesn't flap the sidebar back to idle.
     */
    lastBusyMarkerChangeAt: number;
    exitCode: number | undefined;
    subscribers: Set<Subscriber>;
    /** Bounded scrollback used to replay output to a newly attaching client. */
    scrollbackChunks: string[];
    scrollbackBytes: number;
};

/** Bounded replay buffer per pane for newly attached browser terminals. */
const maxScrollbackBytes = 10_000_000;

/**
 * Fresh zero-initialized map for every entry in `aiBusyMarkerChars`. Used both at pane spawn
 * and on restart so per-marker counts always start from a known baseline.
 */
function newBusyMarkerCounts(): Map<string, number> {
    return new Map(aiBusyMarkerChars.map((marker) => [marker, 0]));
}

/**
 * Increment each tracked counter in `counts` by the number of times its marker appears in
 * `data`. `String#includes` first skips the common no-marker chunk without allocating; `split`
 * on a single-UTF-16-code-unit marker (all of `aiBusyMarkerChars` qualify) gives an accurate
 * occurrence count without any code-point-aware iteration.
 */
function accumulateBusyMarkers(counts: Map<string, number>, data: string): void {
    for (const marker of aiBusyMarkerChars) {
        if (!data.includes(marker)) {
            continue;
        }
        const previous = counts.get(marker) ?? 0;
        counts.set(marker, previous + data.split(marker).length - 1);
    }
}

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
        lastActivityAt: 0,
        busyMarkerCounts: newBusyMarkerCounts(),
        busyMarkerCountsAtLastCheck: newBusyMarkerCounts(),
        lastBusyMarkerChangeAt: 0,
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
    ] = buildPaneCommand(kind, aiCmd, folder);
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
        entry.lastActivityAt = Date.now();
        pty.onData((data) => {
            entry.lastActivityAt = Date.now();
            accumulateBusyMarkers(entry.busyMarkerCounts, data);
            appendScrollback(entry, data);
            entry.subscribers.forEach((subscriber) => {
                subscriber.onData(data);
            });
        });
        pty.onExit(({exitCode}) => {
            /**
             * If this pty was already replaced by a restart, `entry.spawnGeneration` has moved
             * past the value captured at spawn. Swallow the exit so we don't tear down
             * still-attached subscribers — they keep receiving from the fresh pty without seeing
             * a `[connection closed]` blip.
             */
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
    if (!entry?.pty) {
        return;
    }
    // Count the user's keystroke as activity so the sidebar flips to "Working" right away,
    // without waiting for the TUI to echo characters back.
    entry.lastActivityAt = Date.now();
    entry.pty.write(data);
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
    entry.lastActivityAt = 0;
    entry.busyMarkerCounts = newBusyMarkerCounts();
    entry.busyMarkerCountsAtLastCheck = newBusyMarkerCounts();
    entry.lastBusyMarkerChangeAt = 0;
    clearScrollback(entry);
    /**
     * ESC c — full terminal reset. Wipes the screen + cursor state on attached xterms so the
     * incoming fresh session doesn't render on top of the killed session's last frame.
     */
    entry.subscribers.forEach((subscriber) => {
        subscriber.onData('\x1bc');
    });
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

function entryStatus(entry: PaneEntry | undefined, kind: PaneKind): PaneStatus {
    if (!entry) {
        return PaneStatus.None;
    } else if (!entry.pty) {
        return entry.exitCode == undefined ? PaneStatus.None : PaneStatus.Exited;
    }
    if (kind === PaneKind.Ai) {
        // AI Busy logic: each poll (~1s) we snapshot the per-marker counters. A delta on
        // ANY tracked character re-arms `lastBusyMarkerChangeAt`, and the pane reports
        // Busy for `aiBusyHoldMs` (4s) after that timestamp. Combining count-change
        // detection with a hold window means a single quiet poll doesn't flap the sidebar
        // back to Idle; genuine end-of-turn silence still surfaces within 4s. We always
        // copy the current counts into the snapshot at the end so the next poll has a
        // fresh baseline for comparison.
        let changed = false;
        for (const marker of aiBusyMarkerChars) {
            const current = entry.busyMarkerCounts.get(marker) ?? 0;
            const previous = entry.busyMarkerCountsAtLastCheck.get(marker) ?? 0;
            if (current !== previous) {
                changed = true;
                entry.busyMarkerCountsAtLastCheck.set(marker, current);
            }
        }
        if (changed) {
            entry.lastBusyMarkerChangeAt = Date.now();
        }
        return Date.now() - entry.lastBusyMarkerChangeAt < aiBusyHoldMs
            ? PaneStatus.Busy
            : PaneStatus.Idle;
    }
    return Date.now() - entry.lastActivityAt < idleThresholdMs ? PaneStatus.Busy : PaneStatus.Idle;
}

export function listAllPaneStatuses(): StatusEntry[] {
    return Array.from(panes.entries()).map(
        ([
            key,
            entry,
        ]) => {
            const separator = key.lastIndexOf(':');
            const kind = key.slice(separator + 1) as PaneKind;
            return {
                folder: key.slice(0, separator),
                kind,
                status: entryStatus(entry, kind),
            };
        },
    );
}
