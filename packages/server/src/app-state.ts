import {GitHubPollingDisableReason, savedRepoShape} from '@agent-storm/common';
import {readFileIfExists} from '@augment-vir/node';
import {normalizePath, writeFileAtomically} from 'agent-storm';
import {
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    parseJsonWithShape,
} from 'object-shape-tester';
import {appStatePath} from './file-paths.js';
import {createQueuedFile} from './queued-file.js';

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
    /** Set once first-run setup is finished or skipped. */
    isOnboardingDone: optionalShape(false, {
        alsoUndefined: true,
    }),
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

const appStateFile = createQueuedFile({
    description: appStatePath,
    load: loadAppState,
    write: writeAppState,
});

/**
 * Load, modify, and save the state as one queued step. Skips the write when `update` returns
 * `undefined` or when the current state can't be read, so a transient read failure never wipes the
 * repo list.
 */
export const updateAppState = appStateFile.update;
