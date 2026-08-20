import {check} from '@augment-vir/assert';
import {getObjectTypedKeys, omitObjectKeys, wrapInTry} from '@augment-vir/common';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {folderActivityPath, notCommittedDir} from './file-paths.js';
import {normalizePath} from './paths.js';

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
const persistDebounceMs = 10_000;

const storeState: {
    store: ActivityStore;
    /**
     * Whether {@link loadFolderActivity} has run. Nothing is written to disk before it has: a
     * process that stamps without loading first (a test importing this module, say) holds an empty
     * store, and persisting that would erase the user's real history.
     */
    loaded: boolean;
    pendingWrite: Promise<void>;
    persistTimeout: ReturnType<typeof setTimeout> | undefined;
} = {
    store: {},
    loaded: false,
    pendingWrite: Promise.resolve(),
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
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    const raw = parsed as Record<string, unknown>;
    return getObjectTypedKeys(raw).reduce<ActivityStore>((store, folder) => {
        const value = raw[folder];
        if (!check.isNumber(value) || !Number.isFinite(value) || value <= 0) {
            return store;
        }
        return {
            ...store,
            [normalizePath(folder)]: value,
        };
    }, {});
}

export async function loadFolderActivity(): Promise<void> {
    const contents = await readFile(folderActivityPath, 'utf-8').catch(() => undefined);
    storeState.store = contents?.trim() ? parseActivityStore(contents) : {};
    storeState.loaded = true;
}

/**
 * Persist the in-memory store. Writes are chained rather than concurrent, and staged through a temp
 * file then `rename`d over the destination — `rename` is atomic on POSIX within a filesystem, so a
 * crash mid-write leaves the previous version intact instead of a truncated file.
 */
function persistStore(): void {
    if (!storeState.loaded) {
        return;
    }
    const snapshot = JSON.stringify(storeState.store, undefined, 4);
    storeState.pendingWrite = storeState.pendingWrite
        .catch(() => {
            /* a prior write failed; carry on so this one still gets a chance */
        })
        .then(async () => {
            await mkdir(notCommittedDir, {
                recursive: true,
            });
            const tempPath = `${folderActivityPath}.tmp.${process.pid}`;
            await writeFile(tempPath, snapshot, 'utf-8');
            await rename(tempPath, folderActivityPath);
        })
        .catch(() => {
            /* persistence is best-effort — a lost write only costs sort order */
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
    storeState.persistTimeout = setTimeout(() => {
        storeState.persistTimeout = undefined;
        persistStore();
    }, persistDebounceMs);
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
