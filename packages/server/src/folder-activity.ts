import {check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getObjectTypedEntries,
    log,
    omitObjectKeys,
    PromiseQueue,
    wrapInTry,
} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {readFile} from 'node:fs/promises';
import {folderActivityPath} from './file-paths.js';
import {normalizePath} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

/**
 * Folder path → milliseconds since epoch of the last keystroke the user sent to one of that
 * folder's panes. Keys are normalized (see {@link normalizePath}) to match the session store, so
 * `~/foo` and `/Users/x/foo` can't accumulate two independent timestamps for the same directory.
 */
type ActivityStore = Record<string, number>;

/**
 * A keystroke arrives per character typed, so the disk write is debounced rather than fired per
 * stamp. Losing up to this much of a timestamp's precision to a crash is irrelevant to a sort order
 * measured in minutes.
 */
const persistDebounce: AnyDuration = {
    seconds: 10,
};

/** Keeps a slow write from landing after, and overwriting, a newer one. */
const persistQueue = new PromiseQueue();

const storeState: {
    store: ActivityStore;
    /**
     * Whether {@link loadFolderActivity} has run. Nothing is written to disk before it has: a
     * process that stamps without loading first (a test importing this module, say) holds an empty
     * store, and persisting that would erase the user's real history.
     */
    loaded: boolean;
    persistTimeout: ReturnType<typeof setTimeout> | undefined;
} = {
    store: {},
    loaded: false,
    persistTimeout: undefined,
};

/**
 * Parse whatever is on disk, dropping anything malformed. A corrupt file costs the user their sort
 * order until they type in each folder again, which is recoverable; throwing here would take the
 * backend down over a cache file, which is not.
 */
export function parseActivityStore(contents: string): ActivityStore {
    const parsed: unknown = wrapInTry(() => JSON.parse(contents) as unknown, {
        fallbackValue: undefined,
    });
    if (!check.isObject(parsed)) {
        return {};
    }
    return getObjectTypedEntries(parsed).reduce<ActivityStore>(
        (
            store,
            [
                folder,
                value,
            ],
        ) => {
            if (
                !check.isString(folder) ||
                !check.isNumber(value) ||
                !Number.isFinite(value) ||
                value <= 0
            ) {
                return store;
            }
            return {
                ...store,
                [normalizePath(folder)]: value,
            };
        },
        {},
    );
}

export async function loadFolderActivity(): Promise<void> {
    const contents = await readFile(folderActivityPath, 'utf-8').catch(() => undefined);
    storeState.store = contents?.trim() ? parseActivityStore(contents) : {};
    storeState.loaded = true;
}

function persistStore(): void {
    if (!storeState.loaded) {
        return;
    }
    const contents = JSON.stringify(storeState.store, undefined, 4);
    void persistQueue
        .add(async () => {
            await writeFileAtomically({
                path: folderActivityPath,
                contents,
            });
        })
        .catch((error: unknown) => {
            /** Best-effort: a lost write only costs sort order. */
            log.warning(`Failed to save folder activity: ${extractErrorMessage(error)}`);
        });
}

/**
 * Stamp a folder as just-typed-in. Called from the pty WebSocket's message handler, which is every
 * keystroke the user sends, so this does no I/O of its own.
 */
export function recordFolderActivity(folderPath: string): void {
    storeState.store = {
        ...storeState.store,
        [normalizePath(folderPath)]: Date.now(),
    };
    if (storeState.persistTimeout) {
        return;
    }
    storeState.persistTimeout = setTimeout(
        () => {
            storeState.persistTimeout = undefined;
            persistStore();
        },
        convertDuration(persistDebounce, {
            milliseconds: true,
        }).milliseconds,
    );
    /** Don't hold the process open for a sort-order write. */
    storeState.persistTimeout.unref();
}

export function getFolderActivityAtMs(folderPath: string): number {
    return storeState.store[normalizePath(folderPath)] || 0;
}

/**
 * Drop a folder's timestamp. Worktree paths are derived deterministically from the worktree name,
 * so a deleted worktree that leaves its stamp behind would hand it to the next worktree created
 * with the same name.
 */
export function forgetFolderActivity(folderPath: string): void {
    const folder = normalizePath(folderPath);
    if (!(folder in storeState.store)) {
        return;
    }
    storeState.store = omitObjectKeys(storeState.store, [folder]);
    persistStore();
}
