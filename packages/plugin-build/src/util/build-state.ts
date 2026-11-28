// cspell:words unpushed
import {PrStatus, sidebarThreadOrigins, type PluginCallResponse} from '@agent-storm/common';
import {type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {Observable} from 'element-vir';
import {buildPluginId, ThreadOrigin, type buildApi, type Thread} from '../build-api.js';
import {buildClient} from './build-client.js';
import {buildMemory} from './build-memory.js';
import {findPathName, upsertThread, type ThreadRepo} from './thread-timeline.js';

export const buildActivityId = buildPluginId;

/** The route's first sub path while the stage shows the new-thread composer. */
export const newThreadSubPath = 'new';

/** The new-thread composer's pane group scope, whose AI Chat tab starts sidebar threads. */
export const newThreadScope = `build:${newThreadSubPath}`;

/** Everything the Build plugin keeps for the app's whole life. */
export function createBuildState() {
    const draftRepoPath = new Observable<string | undefined>({
        defaultValue: buildMemory.draftRepoPath.read(),
    });
    draftRepoPath.listen(false, (value) => {
        buildMemory.draftRepoPath.write(value);
    });
    return {
        /** Every thread that isn't archived. Undefined until the first list loads. */
        threads: new Observable<ReadonlyArray<Readonly<Thread>> | undefined>({
            defaultValue: undefined,
        }),
        /** Every `ThreadOrigin.SideChat` thread that isn't archived. */
        sideChats: new Observable<ReadonlyArray<Readonly<Thread>>>({
            defaultValue: [],
        }),
        /**
         * Every thread that isn't archived and isn't a `User` or side chat thread. Other plugins
         * show these, so only their AI Chat tab icons read them.
         */
        paneThreads: new Observable<ReadonlyArray<Readonly<Thread>>>({
            defaultValue: [],
        }),
        /**
         * Repo path → epoch milliseconds of its latest thread activity, archived threads included,
         * so archiving a thread doesn't move its repo in the sidebar's activity sort.
         */
        repoActivityAtMs: new Observable<ReadonlyMap<string, number>>({
            defaultValue: new Map(),
        }),
        /** Every archived thread while the sidebar shows them. Undefined while it doesn't. */
        archivedThreads: new Observable<ReadonlyArray<Readonly<Thread>> | undefined>({
            defaultValue: undefined,
        }),
        loadError: new Observable<string | undefined>({
            defaultValue: undefined,
        }),
        /** The checkout the new-thread composer starts its thread in. */
        draftRepoPath,
        /**
         * The open thread the user marked unread. Its chat leaves it unread until the chat goes out
         * of view or another thread is opened.
         */
        markedUnreadThreadId: new Observable<string | undefined>({
            defaultValue: undefined,
        }),
    };
}

export type BuildState = ReturnType<typeof createBuildState>;

/** The Build activity's state. Undefined while the plugin is off. */
export function findBuildState({activityStates}: Readonly<Pick<AppContext, 'activityStates'>>) {
    return activityStates[buildActivityId] satisfies unknown as BuildState | undefined;
}

/** The archive confirmation's text for what the worktree's `readWorktreeChanges` call found. */
export function describeArchiveLoss({
    branch,
    cwd,
    changes,
}: Readonly<{
    branch: string;
    cwd: string;
    changes: Readonly<PluginCallResponse<typeof buildApi, 'readWorktreeChanges'>>;
}>) {
    const isNothingLost = !changes.hasUncommittedChanges && !changes.branchCommitCount;
    return [
        changes.branchCommitCount
            ? unmergedWorktreeWarning(branch)
            : 'Archiving this thread also deletes its worktree.',
        cwd,
        isNothingLost
            ? `Nothing will be lost: there are no uncommitted changes, and the branch "${branch}" has no commits of its own. Archive?`
            : [
                  changes.hasUncommittedChanges ? 'Its uncommitted changes will be lost.' : '',
                  changes.branchCommitCount
                      ? changes.unpushedCommitCount
                          ? `The branch stays, but ${changes.unpushedCommitCount} of its commits only exist locally.`
                          : 'The branch stays, and its commits are pushed.'
                      : 'The branch has no commits of its own.',
                  'Archive anyway?',
              ]
                  .filter(Boolean)
                  .join(' '),
    ].join('\n\n');
}

function unmergedWorktreeWarning(branch: string) {
    return `Archiving this thread also deletes its worktree, but its branch "${branch}" hasn't been merged yet.`;
}

/**
 * Asks the user before archiving a thread would delete a worktree whose branch isn't merged yet.
 * Resolves to `true` when the archive should go ahead, including when there's nothing to ask about.
 * Waits for the first folder poll when it hasn't answered yet.
 */
export async function confirmThreadArchive({
    context,
    thread,
}: Readonly<{
    context: Pick<AppContext, 'activityStates' | 'folderData'>;
    thread: Readonly<Thread>;
}>) {
    if (!context.folderData.value.live) {
        await context.folderData.refresh();
    }
    const folderInfo = context.folderData.value.folderInfo.get(thread.cwd);
    /** Mirrors the server's `archiveThread`, which keeps a worktree another thread works in. */
    const isWorktreeShared = !!findBuildState(context)?.threads.value?.some((other) => {
        return other.id !== thread.id && other.cwd === thread.cwd;
    });
    if (
        !thread.worktreeBranch ||
        !folderInfo ||
        folderInfo.prStatus === PrStatus.Merged ||
        isWorktreeShared
    ) {
        return true;
    }
    try {
        return globalThis.confirm(
            describeArchiveLoss({
                branch: thread.worktreeBranch,
                cwd: thread.cwd,
                changes: await buildClient.call('readWorktreeChanges', {
                    threadId: thread.id,
                }),
            }),
        );
    } catch (error) {
        return globalThis.confirm(
            [
                unmergedWorktreeWarning(thread.worktreeBranch),
                thread.cwd,
                `Checking it for changes failed: ${extractErrorMessage(error)}`,
                'Uncommitted changes in the worktree will be lost. The branch itself stays. Archive anyway?',
            ].join('\n\n'),
        );
    }
}

/** Loads the thread list again, replacing whatever the state had. */
export async function loadThreads(state: Readonly<BuildState>) {
    try {
        const {threads, sideChats, paneThreads, repoActivity} = await buildClient.call(
            'listThreads',
            {},
        );
        state.threads.setValue(threads);
        state.sideChats.setValue(sideChats);
        state.paneThreads.setValue(paneThreads);
        state.repoActivityAtMs.setValue(
            new Map(
                repoActivity.map(({repoPath, updatedAt}) => {
                    return [
                        repoPath,
                        updatedAt,
                    ];
                }),
            ),
        );
        state.loadError.setValue(undefined);
    } catch (error) {
        state.loadError.setValue(extractErrorMessage(error));
    }
}

/** Loads the archived thread list again, unless the sidebar stopped showing it meanwhile. */
export async function loadArchivedThreads(state: Readonly<BuildState>) {
    try {
        const {threads} = await buildClient.call('listArchivedThreads', {});
        if (state.archivedThreads.value) {
            state.archivedThreads.setValue(threads);
        }
    } catch (error) {
        state.loadError.setValue(extractErrorMessage(error));
    }
}

/**
 * Adds or replaces one thread in the state's list, such as one a call just returned, and drops it
 * from the archived list, since the server only sends changes to threads that aren't archived.
 */
export function storeThread(state: Readonly<BuildState>, thread: Readonly<Thread>) {
    if (thread.origin === ThreadOrigin.SideChat) {
        state.sideChats.setValue(upsertThread(state.sideChats.value, thread));
        return;
    } else if (!sidebarThreadOrigins.includes(thread.origin)) {
        state.paneThreads.setValue(upsertThread(state.paneThreads.value, thread));
        return;
    }
    state.threads.setValue(upsertThread(state.threads.value || [], thread));
    if (state.archivedThreads.value?.some((archived) => archived.id === thread.id)) {
        state.archivedThreads.setValue(
            state.archivedThreads.value.filter((archived) => archived.id !== thread.id),
        );
    }
    if (thread.updatedAt > (state.repoActivityAtMs.value.get(thread.repoPath) || 0)) {
        state.repoActivityAtMs.setValue(
            new Map([
                ...state.repoActivityAtMs.value,
                [
                    thread.repoPath,
                    thread.updatedAt,
                ],
            ]),
        );
    }
}

/** Finds a thread in the state's list or, while the sidebar shows them, among archived threads. */
export function findStateThread(state: Readonly<BuildState>, threadId: string) {
    return [
        ...(state.threads.value || []),
        ...(state.archivedThreads.value || []),
    ].find((thread) => thread.id === threadId);
}

/** Drops one thread from the state's list, such as one archived or one that failed to create. */
export function removeThread(state: Readonly<BuildState>, threadId: string) {
    state.threads.setValue(state.threads.value?.filter((thread) => thread.id !== threadId));
}

/** Moves one thread from the state's list to the archived list, when the sidebar shows that list. */
export function markThreadArchived(state: Readonly<BuildState>, threadId: string) {
    const thread = state.threads.value?.find((existing) => existing.id === threadId);
    removeThread(state, threadId);
    if (thread && state.archivedThreads.value) {
        state.archivedThreads.setValue([
            thread,
            ...state.archivedThreads.value,
        ]);
    }
}

/** Loads the thread list and keeps it current from the server's events. Returns the remover. */
export function startThreadSync(state: Readonly<BuildState>) {
    void loadThreads(state);
    const removers = [
        buildClient.listen('threadChanged', (thread) => {
            storeThread(state, thread);
        }),
        buildClient.listen('threadArchived', ({threadId}) => {
            markThreadArchived(state, threadId);
            if (state.sideChats.value.some((sideChat) => sideChat.id === threadId)) {
                state.sideChats.setValue(
                    state.sideChats.value.filter((sideChat) => sideChat.id !== threadId),
                );
            }
            if (state.paneThreads.value.some((paneThread) => paneThread.id === threadId)) {
                state.paneThreads.setValue(
                    state.paneThreads.value.filter((paneThread) => paneThread.id !== threadId),
                );
            }
        }),
    ];
    const removeReconnectListener = buildClient.listenToReconnect(() => {
        void loadThreads(state);
        if (state.archivedThreads.value) {
            void loadArchivedThreads(state);
        }
    });
    return () => {
        removeReconnectListener();
        void Promise.all(removers.map(async (remove) => await remove()));
    };
}

/** The checkouts the sidebar lists: every top-level folder in the app's folder list. */
export function findThreadRepos({folderData}: Readonly<Pick<AppContext, 'folderData'>>) {
    return [
        ...folderData.value.folderInfo.values(),
    ]
        .filter((folder) => !folder.parentRepoPath)
        .map((folder): ThreadRepo => {
            return {
                path: folder.path,
                name: folder.name || findPathName(folder.path),
            };
        });
}
