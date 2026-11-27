import {
    folderSessionsShape,
    PaneKind,
    type FolderSessions,
    type SessionMeta,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    createCuid2,
    getEnumValues,
    getObjectTypedEntries,
    mapEnumToObject,
    mapObjectValues,
    omitObjectKeys,
    wrapInTry,
} from '@augment-vir/common';
import {normalizePath, writeFileAtomically} from 'agent-storm-util';
import {readFile} from 'node:fs/promises';
import {checkValidShape} from 'object-shape-tester';
import {defaultSessionId} from './daemon/protocol.js';
import {sessionStorePath} from './file-paths.js';

/**
 * On-disk shape: folder path → per-kind ordered session lists. Folder keys are always normalized
 * (see {@link normalizePath}) so `~/foo` and `/Users/x/foo` can't accumulate two independent tab
 * sets for the same directory.
 */
type SessionStore = Record<string, FolderSessions>;

const storeState: {
    sessions: SessionStore;
    initialLoad: Promise<void> | undefined;
    pendingWrite: Promise<void>;
} = {
    sessions: {},
    initialLoad: undefined,
    pendingWrite: Promise.resolve(),
};

function createSessionMeta(id: string): SessionMeta {
    return {
        id,
        name: '',
    };
}

/**
 * Parse whatever is on disk into a store, dropping any folder whose entry doesn't match
 * {@link folderSessionsShape} and any session with an empty id. A corrupt or partially written file
 * costs the user their tab names, which is recoverable; throwing here would take the whole backend
 * down over a cache file, which is not.
 */
export function parseSessionStore(contents: string): SessionStore {
    const parsed: unknown = wrapInTry(() => JSON.parse(contents) as unknown, {
        fallbackValue: undefined,
    });
    if (!check.isObject(parsed) || check.isArray(parsed)) {
        return {};
    }
    return getObjectTypedEntries(parsed).reduce<SessionStore>(
        (
            store,
            [
                folder,
                value,
            ],
        ) => {
            if (!check.isString(folder) || !checkValidShape(value, folderSessionsShape)) {
                return store;
            }
            const sessions = mapEnumToObject(PaneKind, (kind) => {
                return value[kind].filter((session) => session.id);
            });
            return {
                ...store,
                [normalizePath(folder)]: sessions,
            };
        },
        {},
    );
}

function loadStore() {
    storeState.initialLoad ||= loadStoreFromDisk().catch((error: unknown) => {
        storeState.initialLoad = undefined;
        throw error;
    });
    return storeState.initialLoad;
}

async function loadStoreFromDisk() {
    const contents = await readFile(sessionStorePath, 'utf-8').catch(() => undefined);
    storeState.sessions = contents?.trim() ? parseSessionStore(contents) : {};
}

/** Writes are chained rather than concurrent, so an older snapshot can never land last. */
function persistStore(store: Readonly<SessionStore>): void {
    const snapshot = JSON.stringify(store, undefined, 4);
    storeState.pendingWrite = storeState.pendingWrite
        .catch(() => {
            /* a prior write failed; carry on so this one still gets a chance */
        })
        .then(async () => {
            await writeFileAtomically({
                path: sessionStorePath,
                contents: snapshot,
            });
        })
        .catch(() => {
            /* persistence is best-effort — a lost write only costs tab names */
        });
}

/** Merge one folder's sessions into the current store, preserving changes to other folders. */
function writeFolder(folder: string, sessions: FolderSessions): void {
    const updated: SessionStore = {
        ...storeState.sessions,
        [folder]: sessions,
    };
    storeState.sessions = updated;
    persistStore(updated);
}

/**
 * Read a folder's sessions, materializing the implicit first session when the folder has no stored
 * entry yet. A folder whose tabs the user closed keeps its empty lists. That lazy default is what
 * preserves single-pane behavior for every folder that existed before multi-session: the user sees
 * one tab, and its id is {@link defaultSessionId} so an attach carrying no `sessionId` resolves to
 * the same PTY.
 */
export async function getFolderSessions(folderPath: string): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    await loadStore();
    return getOrCreateFolderSessions(folder);
}

function getOrCreateFolderSessions(folder: string) {
    const existing = storeState.sessions[folder];
    if (existing) {
        return existing;
    }
    const defaults = mapEnumToObject(PaneKind, () => {
        return [
            createSessionMeta(defaultSessionId),
        ];
    });
    writeFolder(folder, defaults);
    return defaults;
}

/** Unlike {@link findFolderSession}, never creates a folder's default sessions. */
export async function hasFolderSession({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>) {
    await loadStore();
    return !!storeState.sessions[normalizePath(folder)]?.[kind].some((session) => {
        return session.id === sessionId;
    });
}

export async function findFolderSession({
    folder,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>): Promise<SessionMeta | undefined> {
    const sessions = await getFolderSessions(folder);
    return sessions[kind].find((session) => session.id === sessionId);
}

function updateFolderSession({
    folder,
    kind,
    sessionId,
    update,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    update: (session: Readonly<SessionMeta>) => SessionMeta;
}>): FolderSessions {
    const sessions = getOrCreateFolderSessions(folder);
    const updated: FolderSessions = {
        ...sessions,
        [kind]: sessions[kind].map((session) => {
            return session.id === sessionId ? update(session) : session;
        }),
    };
    writeFolder(folder, updated);
    return updated;
}

type CreateFolderSessionParams = Readonly<{
    folder: string;
    kind: PaneKind;
    /** The pane group the tab joins. Empty for the folder's own. */
    scope?: string | undefined;
}>;

export async function createFolderSession({
    folder: folderPath,
    kind,
    scope,
}: CreateFolderSessionParams): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    await loadStore();
    return appendFolderSession({
        folder,
        kind,
        scope,
    });
}

function appendFolderSession({folder, kind, scope}: CreateFolderSessionParams) {
    const current = getOrCreateFolderSessions(folder);
    const updated: FolderSessions = {
        ...current,
        [kind]: [
            ...current[kind],
            {
                ...createSessionMeta(createCuid2()),
                ...(scope
                    ? {
                          scope,
                      }
                    : {}),
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
    await loadStore();
    return updateFolderSession({
        folder,
        kind,
        sessionId,
        update(session) {
            return {
                ...session,
                /** Empty reverts the label to the tab's 1-based index. */
                name: name.trim(),
            };
        },
    });
}

/** Remove a session from the list, including a kind's last one. */
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
    await loadStore();
    const current = getOrCreateFolderSessions(folder);
    if (!current[kind].some((session) => session.id === sessionId)) {
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
    await loadStore();
    if (!storeState.sessions[folder]) {
        return;
    }
    const updated = omitObjectKeys(storeState.sessions, [
        folder,
    ]);
    storeState.sessions = updated;
    persistStore(updated);
}

/**
 * Moves every session of the folder's own pane group into the pane group `scope`. Materializes the
 * folder's default sessions first, so a tab of the moved layout that shows one still finds it.
 */
export async function scopeFolderSessions({
    folder: folderPath,
    scope,
}: Readonly<{
    folder: string;
    scope: string;
}>) {
    const folder = normalizePath(folderPath);
    await loadStore();
    const current = getOrCreateFolderSessions(folder);
    writeFolder(
        folder,
        mapEnumToObject(PaneKind, (kind) => {
            return current[kind].map((session) => {
                return session.scope
                    ? session
                    : {
                          ...session,
                          scope,
                      };
            });
        }),
    );
}

/** Changes each session's scope to the one `renameScope` returns, for a plugin whose id changed. */
export async function renameSessionScopes(renameScope: (scope: string) => string) {
    await loadStore();
    const renamed = mapObjectValues(storeState.sessions, (folder, sessions) => {
        return mapEnumToObject(PaneKind, (kind) => {
            return sessions[kind].map((session) => {
                return session.scope
                    ? {
                          ...session,
                          scope: renameScope(session.scope),
                      }
                    : session;
            });
        });
    });
    if (!check.deepEquals(renamed, storeState.sessions)) {
        storeState.sessions = renamed;
        persistStore(renamed);
    }
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
    await loadStore();
    const stored = getOrCreateFolderSessions(folder);
    const merged = mapEnumToObject(PaneKind, (kind) => {
        const knownIds = stored[kind].map((session) => session.id);
        return [
            ...stored[kind],
            ...liveSessionIds[kind].filter((id) => !knownIds.includes(id)).map(createSessionMeta),
        ];
    });
    if (getEnumValues(PaneKind).some((kind) => merged[kind].length !== stored[kind].length)) {
        writeFolder(folder, merged);
    }
    return merged;
}

/**
 * The id of a folder's first session of `kind`, creating one when the user has closed every tab of
 * that kind.
 */
export async function findOrCreateFirstSession({
    folder: folderPath,
    kind,
}: Readonly<{
    folder: string;
    kind: PaneKind;
}>) {
    const folder = normalizePath(folderPath);
    await loadStore();
    const firstId = getOrCreateFolderSessions(folder)[kind][0]?.id;
    if (firstId) {
        return firstId;
    }
    const created = appendFolderSession({
        folder,
        kind,
    });
    return created[kind].at(-1)?.id || defaultSessionId;
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
