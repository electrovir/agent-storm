import {
    folderSessionsShape,
    PaneKind,
    paneKindRunsAi,
    type FolderSessions,
    type SessionMeta,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    createCuid2,
    getEnumValues,
    getObjectTypedEntries,
    getObjectTypedKeys,
    mapEnumToObject,
    omitObjectKeys,
    wrapInTry,
} from '@augment-vir/common';
import {readdir, readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {checkValidShape} from 'object-shape-tester';
import {defaultSessionId} from './daemon/protocol.js';
import {conversationStateDir, sessionStorePath} from './file-paths.js';
import {normalizePath} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

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

/**
 * The only conversation ids kept from disk. Anything else is replaced, because the id ends up in a
 * file path under {@link conversationStateDir}.
 */
const conversationIdPattern = /^[a-z0-9]+$/;

function createSessionMeta({
    id,
    isNewConversation,
}: Readonly<Pick<SessionMeta, 'id' | 'isNewConversation'>>): SessionMeta {
    return {
        id,
        name: '',
        aiId: '',
        conversationId: createCuid2(),
        isNewConversation,
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
                return value[kind]
                    .filter((session) => session.id)
                    .map((session) => {
                        return conversationIdPattern.test(session.conversationId)
                            ? session
                            : {
                                  ...session,
                                  conversationId: createCuid2(),
                              };
                    });
            });
            return getEnumValues(PaneKind).some((kind) => sessions[kind].length)
                ? {
                      ...store,
                      [normalizePath(folder)]: sessions,
                  }
                : store;
        },
        {},
    );
}

async function loadStore(): Promise<SessionStore> {
    if (storeState.loaded) {
        return storeState.loaded;
    }
    const contents = await readFile(sessionStorePath, 'utf-8').catch(() => undefined);
    const store = contents?.trim() ? parseSessionStore(contents) : {};
    storeState.loaded = store;
    /**
     * Parsing replaces unsafe conversation ids. Persist those right away, or the next backend start
     * would generate different ones and those tabs would lose their conversation.
     */
    if (contents && JSON.stringify(store, undefined, 4) !== contents) {
        persistStore(store);
    }
    return store;
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
    const ensured = mapEnumToObject(PaneKind, (kind) => {
        return existing?.[kind].length
            ? existing[kind]
            : [
                  createSessionMeta({
                      id: defaultSessionId,
                      isNewConversation: false,
                  }),
              ];
    });
    /**
     * Only touch disk when the defaults were actually synthesized, so a plain read of an
     * already-populated folder stays read-only.
     */
    if (getEnumValues(PaneKind).some((kind) => !existing?.[kind].length)) {
        writeFolder(folder, ensured);
    }
    return ensured;
}

/**
 * Delete whatever wrapper scripts recorded for these conversations under
 * {@link conversationStateDir}. Only the mapping goes: the CLI's own transcripts stay where the CLI
 * keeps them. Best-effort, since a leftover mapping file costs a few bytes.
 */
async function forgetConversationState(conversationIds: ReadonlyArray<string>): Promise<void> {
    const cliDirs = await readdir(conversationStateDir).catch(() => []);
    await Promise.all(
        cliDirs.flatMap((cliDir) => {
            return conversationIds.map(async (conversationId) => {
                await rm(join(conversationStateDir, cliDir, conversationId), {
                    force: true,
                }).catch(() => {
                    /* best-effort cleanup */
                });
            });
        }),
    );
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
    sessions,
    sessionId,
    update,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessions: Readonly<FolderSessions>;
    sessionId: string;
    update: (session: Readonly<SessionMeta>) => SessionMeta;
}>): FolderSessions {
    const updated: FolderSessions = {
        ...sessions,
        [kind]: sessions[kind].map((session) => {
            return session.id === sessionId ? update(session) : session;
        }),
    };
    writeFolder(folder, updated);
    return updated;
}

/**
 * Give a tab a new conversation id and make its next spawn use the AI's new-session command. Used
 * when a tab switches onto an AI another tab in the folder already runs, where resuming would open
 * that other tab's conversation.
 */
export async function startNewConversation({
    folder: folderPath,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    const current = await getFolderSessions(folder);
    const previousConversationId = current[kind].find(
        (session) => session.id === sessionId,
    )?.conversationId;
    const updated = updateFolderSession({
        folder,
        kind,
        sessions: current,
        sessionId,
        update(session) {
            return {
                ...session,
                conversationId: createCuid2(),
                isNewConversation: true,
            };
        },
    });
    if (previousConversationId) {
        await forgetConversationState([previousConversationId]);
    }
    return updated;
}

/**
 * Called only once a PTY is actually running with the new-session command. A spawn that failed (the
 * OS out of PTYs, a bad command) leaves the flag set so the retry still starts a new conversation
 * instead of falling back to the resume command.
 */
export async function markConversationStarted({
    folder: folderPath,
    kind,
    sessionId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>): Promise<void> {
    const folder = normalizePath(folderPath);
    updateFolderSession({
        folder,
        kind,
        sessions: await getFolderSessions(folder),
        sessionId,
        update(session) {
            return {
                ...session,
                isNewConversation: false,
            };
        },
    });
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
            createSessionMeta({
                id: createCuid2(),
                /**
                 * An AI's resume command is usually written to pick the last conversation back up
                 * (`claude --continue` and the like), so a new tab launched with it would show the
                 * conversation another tab already holds.
                 */
                isNewConversation: paneKindRunsAi[kind],
            }),
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
    return updateFolderSession({
        folder,
        kind,
        sessions: await getFolderSessions(folder),
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

/**
 * Point one tab at a specific AI, or clear the override with an empty `aiId`. Stored per session
 * rather than in config for the same reason `name` is: it describes this tab, not the folder.
 */
export async function setFolderSessionAi({
    folder: folderPath,
    kind,
    sessionId,
    aiId,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    aiId: string;
}>): Promise<FolderSessions> {
    const folder = normalizePath(folderPath);
    return updateFolderSession({
        folder,
        kind,
        sessions: await getFolderSessions(folder),
        sessionId,
        update(session) {
            return {
                ...session,
                aiId,
            };
        },
    });
}

function pruneSessionListAiIds({
    sessions,
    validAiIds,
}: Readonly<{
    sessions: ReadonlyArray<SessionMeta>;
    validAiIds: ReadonlyArray<string>;
}>) {
    return sessions.map((session) => {
        return session.aiId && !validAiIds.includes(session.aiId)
            ? {
                  ...session,
                  aiId: '',
              }
            : session;
    });
}

export async function pruneSessionAiIds({
    validAiIds,
}: Readonly<{
    validAiIds: ReadonlyArray<string>;
}>) {
    const store = await loadStore();
    const folders = getObjectTypedKeys(store);
    const hasStaleAiId = folders.some((folder) => {
        const sessions = store[folder];
        return !!sessions?.[PaneKind.Ai].some((session) => {
            return session.aiId && !validAiIds.includes(session.aiId);
        });
    });
    if (!hasStaleAiId) {
        return;
    }
    const updated = folders.reduce<SessionStore>((next, folder) => {
        const sessions = store[folder];
        return sessions
            ? {
                  ...next,
                  [folder]: {
                      ...sessions,
                      [PaneKind.Ai]: pruneSessionListAiIds({
                          sessions: sessions[PaneKind.Ai],
                          validAiIds,
                      }),
                  },
              }
            : next;
    }, {});
    storeState.loaded = updated;
    persistStore(updated);
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
    const removedSession = current[kind].find((session) => session.id === sessionId);
    if (current[kind].length <= 1 || !removedSession) {
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
    await forgetConversationState([removedSession.conversationId]);
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
    const forgotten = store[folder];
    if (!forgotten) {
        return;
    }
    const updated = omitObjectKeys(store, [
        folder,
    ]);
    storeState.loaded = updated;
    persistStore(updated);
    await forgetConversationState(
        getEnumValues(PaneKind).flatMap((kind) => {
            return forgotten[kind].map((session) => session.conversationId);
        }),
    );
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
    const merged = mapEnumToObject(PaneKind, (kind) => {
        const knownIds = stored[kind].map((session) => session.id);
        return [
            ...stored[kind],
            ...liveSessionIds[kind]
                .filter((id) => !knownIds.includes(id))
                .map((id) => {
                    return createSessionMeta({
                        id,
                        isNewConversation: false,
                    });
                }),
        ];
    });
    if (getEnumValues(PaneKind).some((kind) => merged[kind].length !== stored[kind].length)) {
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
