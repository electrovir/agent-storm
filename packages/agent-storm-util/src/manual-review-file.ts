import {check, waitUntil} from '@augment-vir/assert';
import {getObjectTypedEntries} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {convertDuration, type AnyDuration} from 'date-vir';
import {mkdir, rm, stat} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {
    checkValidShape,
    defineShape,
    parseJsonWithShape,
    recordShape,
    unknownShape,
    type Shape,
} from 'object-shape-tester';
import {hasErrorCode} from './paths.js';
import {userDataDir} from './user-data-paths.js';

/**
 * The manual-review skill's folder. It holds the skill's {@link manualReviewStatePath}, the folder
 * each PR is reviewed in at `<owner>/<repo>/<PR number>` (made by the Review tab or by
 * `/manual-review here`), and the copies `/manual-review local` makes at `<main checkout's folder
 * name>/<branch>`.
 *
 * @category Internal
 */
export const manualReviewSkillDir = resolve(userDataDir, 'manual-review');

/**
 * Written by the manual-review skill, keyed by `<owner>/<repo>` then head branch.
 *
 * @category Internal
 */
export const manualReviewStatePath = resolve(manualReviewSkillDir, 'state.json');

/**
 * The prefix the manual-review skill puts on the branch it reviews a PR's head branch on.
 *
 * @category Internal
 */
export const reviewBranchPrefix = 'review__';

/**
 * The skill's state file, `<owner>/<repo>` then head branch. Entries are left unchecked here so a
 * rewrite keeps every field, including ones agent-storm doesn't know about.
 *
 * @category Internal
 */
export const manualReviewFileShape = defineShape(
    recordShape({
        keys: '',
        values: recordShape({
            keys: '',
            values: unknownShape(),
        }),
    }),
);

/** @category Internal */
export type ManualReviewFile = typeof manualReviewFileShape.runtimeType;

/**
 * `{}` when the skill hasn't written the file yet. Throws when it can't be parsed.
 *
 * @category Util
 */
export async function readManualReviewFile(statePath: string) {
    const contents = await readFileIfExists(statePath);
    return contents == undefined ? {} : parseJsonWithShape(contents, manualReviewFileShape);
}

/**
 * Every entry in the file that matches `entryShape`, along with the repo and branch it's recorded
 * under. Entries that don't match are skipped rather than failing the whole list.
 *
 * @category Util
 */
export function listManualReviewEntries<const EntryShape extends Shape>({
    file,
    entryShape,
}: Readonly<{
    file: Readonly<ManualReviewFile>;
    entryShape: EntryShape;
}>) {
    return getObjectTypedEntries(file).flatMap(
        ([
            repoKey,
            branches,
        ]) => {
            const repoParts = repoKey.split('/');
            if (!check.isLengthExactly(repoParts, 2)) {
                return [];
            }
            return getObjectTypedEntries(branches).flatMap(
                ([
                    branchName,
                    entry,
                ]) => {
                    return checkValidShape(entry, entryShape)
                        ? [
                              {
                                  owner: repoParts[0],
                                  repoName: repoParts[1],
                                  branchName,
                                  entry,
                              },
                          ]
                        : [];
                },
            );
        },
    );
}

/** As old as the skill's `review-state.ts` lets a lock get before it takes the lock over. */
const staleLockAge: AnyDuration = {
    seconds: 10,
};

/**
 * Takes the same lock directory the skill's `review-state.ts` takes, since both rewrite the whole
 * file. False while another process holds it.
 */
async function tryTakeLock(lockPath: string) {
    try {
        await mkdir(lockPath);
        return true;
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
            throw error;
        }
    }
    const lockMtime = (await stat(lockPath).catch(() => undefined))?.mtimeMs;
    if (
        lockMtime != undefined &&
        Date.now() - lockMtime >
            convertDuration(staleLockAge, {
                milliseconds: true,
            }).milliseconds
    ) {
        await rm(lockPath, {
            recursive: true,
            force: true,
        });
    }
    return false;
}

/**
 * Runs `callback` while holding the lock the skill's `review-state.ts` takes before rewriting its
 * state file, so neither side's rewrite drops the other's.
 *
 * @category Util
 */
export async function withManualReviewStateLock<T>({
    statePath,
    callback,
}: Readonly<{
    statePath: string;
    callback: () => Promise<T>;
}>) {
    const lockPath = `${statePath}.lock`;
    await mkdir(dirname(lockPath), {
        recursive: true,
    });
    await waitUntil.isTrue(
        async () => await tryTakeLock(lockPath),
        {
            interval: {
                milliseconds: 25,
            },
            timeout: {
                seconds: 5,
            },
        },
        `Timed out waiting for another process to release ${lockPath}.`,
    );
    try {
        return await callback();
    } finally {
        await rm(lockPath, {
            recursive: true,
            force: true,
        });
    }
}
