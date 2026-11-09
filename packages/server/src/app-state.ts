import {GitHubPollingDisableReason, savedRepoShape} from '@agent-storm/common';
import {log, PromiseQueue} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {defineShape, enumShape, nullableShape, parseJsonWithShape} from 'object-shape-tester';
import {appStatePath} from './file-paths.js';
import {normalizePath} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

/**
 * Saved so a restart during development doesn't immediately poll GitHub again and hit the same rate
 * limit.
 */
export const githubPollingAutoDisableShape = nullableShape({
    reason: enumShape(GitHubPollingDisableReason),
    disabledUntilMs: 0,
});

/** What the app records on its own, kept out of the user's settings file. */
const appStateShape = defineShape({
    repos: [savedRepoShape],
    githubPollingAutoDisable: githubPollingAutoDisableShape,
});

export type AppState = typeof appStateShape.runtimeType;

/** A missing file is the default state. A malformed one throws rather than being replaced. */
export async function loadAppState(): Promise<AppState> {
    const contents = await readFileIfExists(appStatePath);
    /** The shape hands out one shared default object, so its array isn't given to callers. */
    return contents == undefined
        ? {
              repos: [],
              githubPollingAutoDisable: null,
          }
        : parseJsonWithShape(contents, appStateShape);
}

export async function writeAppState(state: Readonly<AppState>) {
    await writeFileAtomically({
        path: appStatePath,
        contents: JSON.stringify(
            {
                ...state,
                repos: state.repos.map((repo) => {
                    return {
                        ...repo,
                        path: normalizePath(repo.path),
                    };
                }),
            },
            undefined,
            4,
        ),
    });
}

/** Serializes every state write, so two load-modify-save updates can't drop each other's change. */
const appStateWriteQueue = new PromiseQueue();

/**
 * Load, modify, and save the state as one queued step. Skips the write when `update` returns
 * `undefined` or when the current state can't be read, so a transient read failure never wipes the
 * repo list.
 */
export async function updateAppState(
    update: (state: Readonly<AppState>) => AppState | undefined,
): Promise<void> {
    await appStateWriteQueue.add(async () => {
        const state = await loadAppState().catch((error: unknown) => {
            log.warning(`Not updating ${appStatePath}, it can't be read: ${String(error)}`);
            return undefined;
        });
        const updated = state && update(state);
        if (updated) {
            await writeAppState(updated);
        }
    });
}
