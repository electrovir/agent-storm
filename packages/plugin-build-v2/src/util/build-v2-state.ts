import {type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {Observable} from 'element-vir';
import {buildV2PluginId, type Thread} from '../build-v2-api.js';
import {buildV2Client} from './build-v2-client.js';
import {buildV2Memory} from './build-v2-memory.js';
import {findPathName, upsertThread, type ThreadRepo} from './thread-timeline.js';

export const buildV2ActivityId = buildV2PluginId;

/** The route's first sub path while the stage shows the new-thread composer. */
export const newThreadSubPath = 'new';

/** Everything the Build V2 plugin keeps for the app's whole life. */
export function createBuildV2State() {
    const draftRepoPath = new Observable<string | undefined>({
        defaultValue: buildV2Memory.draftRepoPath.read(),
    });
    draftRepoPath.listen(false, (value) => {
        buildV2Memory.draftRepoPath.write(value);
    });
    return {
        /** Every thread that isn't archived. Undefined until the first list loads. */
        threads: new Observable<ReadonlyArray<Readonly<Thread>> | undefined>({
            defaultValue: undefined,
        }),
        /**
         * Repo path → epoch milliseconds of its latest thread activity, archived threads included,
         * so archiving a thread doesn't move its repo in the sidebar's activity sort.
         */
        repoActivityAtMs: new Observable<ReadonlyMap<string, number>>({
            defaultValue: new Map(),
        }),
        loadError: new Observable<string | undefined>({
            defaultValue: undefined,
        }),
        /** The checkout the new-thread composer starts its thread in. */
        draftRepoPath,
    };
}

export type BuildV2State = ReturnType<typeof createBuildV2State>;

/** The Build V2 activity's state. Undefined while the plugin is off. */
export function findBuildV2State({activityStates}: Readonly<Pick<AppContext, 'activityStates'>>) {
    return activityStates[buildV2ActivityId] satisfies unknown as BuildV2State | undefined;
}

/** Loads the thread list again, replacing whatever the state had. */
export async function loadThreads(state: Readonly<BuildV2State>) {
    try {
        const {threads, repoActivity} = await buildV2Client.call('listThreads', {});
        state.threads.setValue(threads);
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

/** Adds or replaces one thread in the state's list, such as one a call just returned. */
export function storeThread(state: Readonly<BuildV2State>, thread: Readonly<Thread>) {
    state.threads.setValue(upsertThread(state.threads.value || [], thread));
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

/** Loads the thread list and keeps it current from the server's events. Returns the remover. */
export function startThreadSync(state: Readonly<BuildV2State>) {
    void loadThreads(state);
    const removers = [
        buildV2Client.listen('threadChanged', (thread) => {
            storeThread(state, thread);
        }),
        buildV2Client.listen('threadArchived', ({threadId}) => {
            state.threads.setValue(state.threads.value?.filter((thread) => thread.id !== threadId));
        }),
    ];
    const removeReconnectListener = buildV2Client.listenToReconnect(() => {
        void loadThreads(state);
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
