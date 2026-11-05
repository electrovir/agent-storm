import {type ReviewComment} from '@agent-storm/common';
import {check, waitUntil} from '@augment-vir/assert';
import {convertDuration, type AnyDuration} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {mkdir, rm, stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {checkValidShape} from 'object-shape-tester';
import {isSafeBranchName} from './branch-name.js';
import {manualReviewStatePath} from './file-paths.js';
import {getCurrentBranch, getRepoSlug, tryGit} from './git.js';
import {
    listManualReviewEntries,
    manualReviewEntryShape,
    readManualReviewFile,
    reviewBranchPrefix,
    type ManualReviewFile,
} from './manual-review-state.js';
import {hasErrorCode} from './paths.js';
import {writeFileAtomically} from './write-file-atomically.js';

function getEntry({
    state,
    repo,
    branch,
}: Readonly<{
    state: Readonly<ManualReviewFile>;
    repo: string;
    branch: string;
}>) {
    const entry = state[repo]?.[branch];
    return check.isObject(entry) ? entry : undefined;
}

function getEntryComments(entry: unknown) {
    return (checkValidShape(entry, manualReviewEntryShape) && entry.comments) || [];
}

/**
 * The skill's state entry for the review the folder holds: the entry recorded for this checkout
 * when there is one, otherwise the one its `origin` repo and head branch name, which is where the
 * skill records a review it hasn't started yet.
 */
async function resolveEntryKey(folder: string, state: Readonly<ManualReviewFile>) {
    const branch = await getCurrentBranch(folder);
    const headBranch = branch?.startsWith(reviewBranchPrefix)
        ? branch.slice(reviewBranchPrefix.length)
        : branch;
    if (!headBranch || !isSafeBranchName(headBranch)) {
        return undefined;
    }
    const topLevel = (
        await tryGit(folder, [
            'rev-parse',
            '--show-toplevel',
        ])
    )?.trim();
    const recorded = listManualReviewEntries(state).find((listed) => {
        return listed.branchName === headBranch && listed.entry.folder === topLevel;
    });
    if (recorded) {
        return {
            repo: `${recorded.owner}/${recorded.repoName}`,
            branch: headBranch,
        };
    }
    const slug = await getRepoSlug(folder);
    return slug
        ? {
              repo: `${slug.owner}/${slug.name}`,
              branch: headBranch,
          }
        : undefined;
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

async function updateEntryComments({
    folder,
    statePath,
    update,
}: Readonly<{
    folder: string;
    statePath: string;
    update: (comments: ReadonlyArray<ReviewComment>) => ReviewComment[];
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
        const state = await readManualReviewFile(statePath);
        const key = await resolveEntryKey(folder, state);
        if (!key) {
            throw new Error(`Cannot tell which review ${folder} holds: it is not on a branch.`);
        }
        const entry = getEntry({
            state,
            repo: key.repo,
            branch: key.branch,
        });
        const comments = update(getEntryComments(entry));
        await writeFileAtomically({
            path: statePath,
            contents: `${JSON.stringify(
                {
                    ...state,
                    [key.repo]: {
                        ...state[key.repo],
                        [key.branch]: {
                            ...entry,
                            comments,
                        },
                    },
                },
                undefined,
                4,
            )}\n`,
        });
        return comments;
    } finally {
        await rm(lockPath, {
            recursive: true,
            force: true,
        });
    }
}

/**
 * Comments the reviewer wrote in the diff pane for the review the folder holds, stored in the
 * manual-review skill's state file so its verdict commands post them alongside the code markers.
 */
export async function readReviewComments({
    folder,
    statePath,
}: Readonly<{
    folder: string;
    /** Defaults to the skill's own state file. */
    statePath?: string | undefined;
}>) {
    const state = await readManualReviewFile(statePath || manualReviewStatePath);
    const key = await resolveEntryKey(folder, state);
    return key
        ? getEntryComments(
              getEntry({
                  state,
                  repo: key.repo,
                  branch: key.branch,
              }),
          )
        : [];
}

/** Answers with the review's comments after the change. */
export async function addReviewComment({
    folder,
    statePath,
    path,
    line,
    body,
}: Readonly<
    Omit<ReviewComment, 'id'> & {
        folder: string;
        /** Defaults to the skill's own state file. */
        statePath?: string | undefined;
    }
>) {
    return await updateEntryComments({
        folder,
        statePath: statePath || manualReviewStatePath,
        update(comments) {
            return [
                ...comments,
                {
                    id: randomUUID(),
                    path,
                    line,
                    body,
                },
            ];
        },
    });
}

/** Answers with the review's comments after the change. */
export async function updateReviewComment({
    folder,
    statePath,
    id,
    body,
}: Readonly<
    Pick<ReviewComment, 'id' | 'body'> & {
        folder: string;
        /** Defaults to the skill's own state file. */
        statePath?: string | undefined;
    }
>) {
    return await updateEntryComments({
        folder,
        statePath: statePath || manualReviewStatePath,
        update(comments) {
            return comments.map((comment) => {
                return comment.id === id
                    ? {
                          ...comment,
                          body,
                      }
                    : comment;
            });
        },
    });
}

/** Answers with the review's comments after the change. */
export async function deleteReviewComment({
    folder,
    statePath,
    id,
}: Readonly<{
    folder: string;
    /** Defaults to the skill's own state file. */
    statePath?: string | undefined;
    id: string;
}>) {
    return await updateEntryComments({
        folder,
        statePath: statePath || manualReviewStatePath,
        update(comments) {
            return comments.filter((comment) => comment.id !== id);
        },
    });
}
