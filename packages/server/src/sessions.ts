import {PaneKind, type FolderSessions, type SessionMeta} from '@agent-storm/common';
import {getObjectTypedKeys, wrapInTry} from '@augment-vir/common';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {defaultSessionId} from './daemon/protocol.js';
import {notCommittedDir, sessionStorePath} from './file-paths.js';
import {normalizePath} from './paths.js';

/**
 * On-disk shape: folder path → per-kind ordered session lists. Folder keys are always normalized
 * (see {@link normalizePath}) so `~/foo` and `/Users/x/foo` can't accumulate two independent tab
 * sets for the same directory.
 */
type SessionStore = Record<string, FolderSessions>;

const storeState: {
    loaded: SessionStore | undefined;
    pendingWrite: Promise<void>;
} = {
    loaded: undefined,
    pendingWrite: Promise.resolve(),
};

function isSessionMetaArray(value: unknown): value is SessionMeta[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry) =>
                !!entry &&
                typeof entry === 'object' &&
                typeof (entry as SessionMeta).id === 'string' &&
                !!(entry as SessionMeta).id,
        )
    );
}

function normalizeStoredSession(entry: Readonly<SessionMeta>): SessionMeta {
    return {
        id: entry.id,
        name: typeof entry.name === 'string' ? entry.name : '',
    };
}

/**
 * Parse whatever is on disk into a store, dropping anything malformed. A corrupt or partially
 * written file costs the user their tab names, which is recoverable; throwing here would take the
 * whole backend down over a cache file, which is not.
 */
export function parseSessionStore(contents: string): SessionStore {
    const parsed: unknown = wrapInTry(() => JSON.parse(contents) as unknown, {
        fallbackValue: undefined,
    });
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    const raw = parsed as Record<string, unknown>;
    return getObjectTypedKeys(raw).reduce<SessionStore>((store, folder) => {
        const value = raw[folder] as Partial<FolderSessions> | undefined;
        const ai = isSessionMetaArray(value?.ai) ? value.ai : [];
        const shell = isSessionMetaArray(value?.shell) ? value.shell : [];
        if (ai.length === 0 && shell.length === 0) {
            return store;
        }
        return {
            ...store,
            [normalizePath(folder)]: {
                ai: ai.map((entry) => normalizeStoredSession(entry)),
                shell: shell.map((entry) => normalizeStoredSession(entry)),
            },
        };
    }, {});
}

async function loadStore(): Promise<SessionStore> {
    if (storeState.loaded) {
        return storeState.loaded;
    }
    const contents = await readFile(sessionStorePath, 'utf-8').catch(() => undefined);
    const store = contents?.trim() ? parseSessionStore(contents) : {};
    storeState.loaded = store;
    return store;
}

/**
 * Persist the in-memory store. Writes are chained rather than concurrent, and staged through a temp
 * file then `rename`d over the destination — `rename` is atomic on POSIX within a filesystem, so a
 * crash mid-write leaves the previous version intact instead of a truncated file.
 */
function persistStore(store: Readonly<SessionStore>): void {
    const snapshot = JSON.stringify(store, undefined, 4);
    storeState.pendingWrite = storeState.pendingWrite
        .catch(() => {
            /* a prior write failed; carry on so this one still gets a chance */
        })
        .then(async () => {
            await mkdir(notCommittedDir, {
                recursive: true,
            });
            const tempPath = `${sessionStorePath}.tmp.${process.pid}`;
            await writeFile(tempPath, snapshot, 'utf-8');
            await rename(tempPath, sessionStorePath);
        })
        .catch(() => {
            /* persistence is best-effort — a lost write only costs tab names */
        });
}

/**
 * Merge one folder's sessions into the store. Reads `storeState.loaded` at call time rather than
 * taking a snapshot parameter: callers necessarily `await` a load first, and another write landing
 * during that await would be silently dropped if we spread a store captured before it.
 */
function writeFolder(folder: string, sessions: FolderSessions): void {
    const updated: SessionStore = {
        ...storeState.loaded,
        [folder]: sessions,
    };
    storeState.loaded = updated;
    persistStore(updated);
}

/**
 * Read a folder's sessions, materializing the implicit first session when none is stored yet. That
 * lazy default is what preserves single-pane behavior for every folder that existed before
 * multi-session: the user sees one tab, and its id is {@link defaultSessionId} so an attach carrying
 * no `sessionId` resolves to the same PTY.
 */
export async function getFolderSessions(folderPath: string): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    const store = await loadStore();
    const existing = store[folder];
    const ensured: FolderSessions = {
        ai: existing?.ai.length ? existing.ai : [initialSession()],
        shell: existing?.shell.length ? existing.shell : [initialSession()],
    };
    /**
     * Only touch disk when the defaults were actually synthesized, so a plain read of an
     * already-populated folder stays read-only.
     */
    if (!existing?.ai.length || !existing.shell.length) {
        writeFolder(folder, ensured);
    }
    return ensured;
}

function initialSession(): SessionMeta {
    return {
        id: defaultSessionId,
        name: '',
    };
}

export async function createFolderSession({
    folder: folderPath,
    kind,
}: Readonly<{
    folder: string;
    kind: PaneKind;
}>): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    const current = await getFolderSessions(folder);
    const updated: FolderSessions = {
        ...current,
        [kind]: [
            ...current[kind],
            {
                id: randomUUID(),
                name: '',
            },
        ],
    };
    writeFolder(folder, updated);
    return updated;
}

export async function renameFolderSession({
    folder: folderPath,
    kind,
    sessionId,
    name,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    name: string;
}>): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    const current = await getFolderSessions(folder);
    const updated: FolderSessions = {
        ...current,
        [kind]: current[kind].map((session) =>
            session.id === sessionId
                ? {
                      ...session,
                      /** Empty reverts the label to the tab's 1-based index. */
                      name: name.trim(),
                  }
                : session,
        ),
    };
    writeFolder(folder, updated);
    return updated;
}

/**
 * Remove a session from the list. Refuses to drop the last remaining session of a kind — a pane
 * with zero tabs has nothing to render, and the lazy default in {@link getFolderSessions} would
 * immediately recreate one anyway.
 */
export async function removeFolderSession({
    folder: folderPath,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>): Promise<{sessions: FolderSessions; removed: boolean}> {
    const folder = normalizePath(folderPath);
    const current = await getFolderSessions(folder);
    if (current[kind].length <= 1 || !current[kind].some((session) => session.id === sessionId)) {
        return {
            sessions: current,
            removed: false,
        };
    }
    const updated: FolderSessions = {
        ...current,
        [kind]: current[kind].filter((session) => session.id !== sessionId),
    };
    writeFolder(folder, updated);
    return {
        sessions: updated,
        removed: true,
    };
}

/**
 * Forget every session for a folder. Called when a worktree is deleted or a repo is dropped from
 * config: without it, entries outlive the folder, and because worktree paths are derived
 * deterministically from the worktree name, creating a new worktree with a previously-used name
 * would inherit the old incarnation's tabs — named, PTY-less, and confusing.
 *
 * Deliberately NOT wired into the folder-info sweep. `listWorktreeChildren` swallows read errors
 * into an empty array, so an unmounted volume or a permissions blip would enumerate zero children
 * and silently erase every tab name under that repo. Git state can be recomputed next sweep; a name
 * the user typed cannot.
 */
export async function forgetFolderSessions(folderPath: string): Promise<void> {
    const folder = normalizePath(folderPath);
    const store = await loadStore();
    if (!store[folder]) {
        return;
    }
    const updated = getObjectTypedKeys(store).reduce<SessionStore>((next, key) => {
        if (key === folder) {
            return next;
        }
        const value = store[key];
        return value
            ? {
                  ...next,
                  [key]: value,
              }
            : next;
    }, {});
    storeState.loaded = updated;
    persistStore(updated);
}

/**
 * Merge live daemon sessions into the stored list so a running PTY can never be missing a tab. The
 * store is authoritative for order and names, but if the two ever diverge — a store write that
 * failed, a session created against a daemon that then outlived the backend — an unlisted PTY would
 * be invisible while still consuming a CPU-burning agent process. Appending it makes it closable.
 */
export async function reconcileFolderSessions({
    folder: folderPath,
    liveSessionIds,
}: Readonly<{
    folder: string;
    liveSessionIds: Readonly<Record<PaneKind, ReadonlyArray<string>>>;
}>): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    const stored = await getFolderSessions(folder);
    const merged = Object.values(PaneKind).reduce<FolderSessions>(
        (next, kind) => {
            const known = new Set(next[kind].map((session) => session.id));
            const orphans = liveSessionIds[kind]
                .filter((id) => !known.has(id))
                .map((id): SessionMeta => {
                    return {
                        id,
                        name: '',
                    };
                });
            return orphans.length === 0
                ? next
                : {
                      ...next,
                      [kind]: [
                          ...next[kind],
                          ...orphans,
                      ],
                  };
        },
        {
            ai: stored.ai,
            shell: stored.shell,
        },
    );
    if (merged.ai.length !== stored.ai.length || merged.shell.length !== stored.shell.length) {
        writeFolder(folder, merged);
    }
    return merged;
}

/**
 * Resolve a client-supplied session id to one that actually exists, falling back to the folder's
 * first session. Keeps a stale client (or a hand-edited URL) from spawning a PTY under an id no tab
 * references.
 */
export async function resolveSessionId({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId?: string | undefined;
}>): Promise<string> {
    const sessions = await getFolderSessions(folder);
    const known = sessions[kind];
    if (sessionId && known.some((session) => session.id === sessionId)) {
        return sessionId;
    }
    return known[0]?.id || defaultSessionId;
}
