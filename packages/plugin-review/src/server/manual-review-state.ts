import {
    manualReviewStateShape,
    ManualReviewStatus,
    ManualReviewVerdict,
    reviewCommentShape,
    type ManualReviewState,
    type PullRequestBranch,
    type PullRequestRef,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    createBlockingInterval,
    extractErrorMessage,
    log,
    type MaybePromise,
} from '@augment-vir/common';
import {
    listManualReviewEntries,
    manualReviewSkillDir,
    manualReviewStatePath,
    readManualReviewFile,
    runCommand,
    withManualReviewStateLock,
    writeFileAtomically,
} from 'agent-storm-util';
import {convertDuration, type AnyDuration} from 'date-vir';
import {resolve} from 'node:path';
import {
    checkValidShape,
    defineShape,
    enumShape,
    intersectShape,
    partialShape,
} from 'object-shape-tester';

/**
 * The folder a PR is reviewed in, whether Agent Storm's Review tab or the skill's `/manual-review
 * here` makes it.
 */
export function toReviewFolder({owner, repoName, number}: Readonly<PullRequestRef>) {
    return resolve(manualReviewSkillDir, owner, repoName, String(number));
}

/** The statuses the skill records once it has posted an approval or change request. */
export const postedVerdictStatuses: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Approved]: true,
    [ManualReviewStatus.RequestedChanges]: true,
    [ManualReviewStatus.Aborted]: false,
    [ManualReviewStatus.Commented]: false,
    [ManualReviewStatus.PostFailed]: false,
    [ManualReviewStatus.Started]: false,
};

/**
 * One review as the skill records it. Every field is optional because agent-storm stores a
 * diff-pane comment on a branch before the skill has recorded anything for it.
 */
export const manualReviewEntryShape = defineShape(
    intersectShape(
        partialShape(manualReviewStateShape),
        partialShape({
            prNumber: 0,
            prUrl: '',
            /** Top of the checkout the review runs in. */
            folder: '',
            /** Only while `status` is `postFailed`: the verdict whose post failed. */
            failedVerdict: enumShape(ManualReviewVerdict),
            comments: [
                reviewCommentShape,
            ],
        }),
    ),
);

export type ManualReviewEntry = typeof manualReviewEntryShape.runtimeType;

export type ListedManualReviewEntry = ReturnType<
    typeof listManualReviewEntries<typeof manualReviewEntryShape>
>[number];

/** Undefined when the skill never recorded the branch or its state file can't be read. */
export async function readManualReviewEntry({
    owner,
    repoName,
    branchName,
}: Readonly<PullRequestBranch>) {
    try {
        const entry = (await readManualReviewFile(manualReviewStatePath))[`${owner}/${repoName}`]?.[
            branchName
        ];
        return checkValidShape(entry, manualReviewEntryShape) ? entry : undefined;
    } catch {
        return undefined;
    }
}

/** Undefined until the skill records a status for the branch. */
export async function readManualReviewState(branch: Readonly<PullRequestBranch>) {
    const entry = await readManualReviewEntry(branch);
    return entry?.status && entry.isPending != undefined && entry.lastUpdatedAt != undefined
        ? ({
              status: entry.status,
              isPending: entry.isPending,
              lastUpdatedAt: entry.lastUpdatedAt,
              headSha: entry.headSha,
          } satisfies ManualReviewState)
        : undefined;
}

/** Called with every entry whose status changed since the previous read of the state file. */
export type ManualReviewListener = (
    changedEntries: ReadonlyArray<ListedManualReviewEntry>,
) => MaybePromise<void>;

const manualReviewWatch: {
    listeners: ReadonlyArray<ManualReviewListener>;
    /** Undefined until the first successful read. */
    previousEntries: ReadonlyArray<ListedManualReviewEntry> | undefined;
    /** Undefined while nothing listens. */
    stopPolling: (() => void) | undefined;
} = {
    listeners: [],
    previousEntries: undefined,
    stopPolling: undefined,
};

function toEntryKey({owner, repoName, branchName}: Readonly<PullRequestBranch>) {
    return [
        owner,
        repoName,
        branchName,
    ].join('/');
}

/**
 * The skill scripts that work on each status while it's pending, how long it must have been pending
 * before none of them running means it's abandoned, and the status it settles back to then.
 */
const pendingStatusCleanups: Readonly<
    Record<
        ManualReviewStatus,
        | Readonly<{
              scripts: ReadonlyArray<string>;
              minPendingAge: AnyDuration;
              settledStatus: ManualReviewStatus;
          }>
        | undefined
    >
> = {
    /**
     * These scripts clear the flag from an exit trap, which a hard kill of the script skips,
     * leaving the review locked as pending forever.
     */
    [ManualReviewStatus.Started]: {
        scripts: [
            '/run-review.sh',
        ],
        minPendingAge: {
            milliseconds: 0,
        },
        settledStatus: ManualReviewStatus.Started,
    },
    [ManualReviewStatus.Aborted]: {
        scripts: [
            '/abort-review.sh',
        ],
        minPendingAge: {
            milliseconds: 0,
        },
        settledStatus: ManualReviewStatus.Aborted,
    },
    /**
     * `post-github-comments.ts --dry-run` marks the verdict pending, and only `commit-review.sh`
     * after a real post clears it. No script runs between the two while the AI copyedits, so only a
     * long gap means the AI stopped without posting (such as on finding the PR already approved).
     * Nothing was posted, so the review goes back to started; a later real post records its verdict
     * again.
     */
    [ManualReviewStatus.Approved]: {
        scripts: [
            '/post-github-comments.ts',
            '/commit-review.sh',
        ],
        minPendingAge: {
            minutes: 5,
        },
        settledStatus: ManualReviewStatus.Started,
    },
    [ManualReviewStatus.RequestedChanges]: {
        scripts: [
            '/post-github-comments.ts',
            '/commit-review.sh',
        ],
        minPendingAge: {
            minutes: 5,
        },
        settledStatus: ManualReviewStatus.Started,
    },
    [ManualReviewStatus.Commented]: {
        scripts: [
            '/post-github-comments.ts',
            '/commit-review.sh',
        ],
        minPendingAge: {
            minutes: 5,
        },
        settledStatus: ManualReviewStatus.Started,
    },
    [ManualReviewStatus.PostFailed]: undefined,
};

/** Settles pending entries that no skill script is working on anymore. */
async function clearOrphanedPendingEntries(entries: ReadonlyArray<ListedManualReviewEntry>) {
    const nowMs = Date.now();
    const candidates = entries.filter((listed) => {
        const cleanup = listed.entry.status && pendingStatusCleanups[listed.entry.status];
        return (
            !!listed.entry.isPending &&
            !!cleanup &&
            nowMs - (listed.entry.lastUpdatedAt ?? 0) >=
                convertDuration(cleanup.minPendingAge, {
                    milliseconds: true,
                }).milliseconds
        );
    });
    if (!candidates.length) {
        return;
    }
    const {stdout: runningCommands} = await runCommand(
        'ps',
        [
            '-axo',
            'command=',
        ],
        {
            timeout: {
                seconds: 5,
            },
        },
    );
    const orphaned = candidates.filter((listed) => {
        const cleanup = listed.entry.status && pendingStatusCleanups[listed.entry.status];
        return (
            !!cleanup &&
            !cleanup.scripts.some((script) => {
                return runningCommands.includes(script);
            })
        );
    });
    if (!orphaned.length) {
        return;
    }
    await withManualReviewStateLock({
        statePath: manualReviewStatePath,
        async callback() {
            const file = await readManualReviewFile(manualReviewStatePath);
            /** A run that started since the read above has rewritten its entry, so it's skipped. */
            const updated = orphaned.reduce((current, listed) => {
                const repoKey = [
                    listed.owner,
                    listed.repoName,
                ].join('/');
                const stored = current[repoKey]?.[listed.branchName];
                const cleanup = listed.entry.status && pendingStatusCleanups[listed.entry.status];
                return cleanup &&
                    check.isObject(stored) &&
                    stored.isPending === true &&
                    stored.lastUpdatedAt === listed.entry.lastUpdatedAt
                    ? {
                          ...current,
                          [repoKey]: {
                              ...current[repoKey],
                              [listed.branchName]: {
                                  ...stored,
                                  status: cleanup.settledStatus,
                                  isPending: false,
                              },
                          },
                      }
                    : current;
            }, file);
            if (updated !== file) {
                await writeFileAtomically({
                    path: manualReviewStatePath,
                    contents: `${JSON.stringify(updated, undefined, 4)}\n`,
                });
            }
        },
    });
    log.info(
        `Settled pending manual reviews that no script is working on: ${orphaned
            .map((listed) => listed.branchName)
            .join(', ')}`,
    );
}

async function pollManualReviewFile() {
    try {
        const entries = listManualReviewEntries({
            file: await readManualReviewFile(manualReviewStatePath),
            entryShape: manualReviewEntryShape,
        });
        /** `ps` is missing on Windows, where the skill's bash scripts don't run either. */
        await clearOrphanedPendingEntries(entries).catch(() => undefined);
        const previousEntries = manualReviewWatch.previousEntries;
        manualReviewWatch.previousEntries = entries;
        if (!previousEntries) {
            return;
        }
        const changedEntries = entries.filter((listed) => {
            const previous = previousEntries.find((previousListed) => {
                return toEntryKey(previousListed) === toEntryKey(listed);
            })?.entry;
            return (
                !previous ||
                previous.status !== listed.entry.status ||
                previous.isPending !== listed.entry.isPending ||
                previous.lastUpdatedAt !== listed.entry.lastUpdatedAt
            );
        });
        if (!changedEntries.length) {
            return;
        }
        await Promise.all(
            manualReviewWatch.listeners.map(async (listener) => {
                try {
                    await listener(changedEntries);
                } catch (error) {
                    log.warning(
                        `A manual review state listener failed: ${extractErrorMessage(error)}`,
                    );
                }
            }),
        );
    } catch {
        /**
         * A failed read keeps the last good one, so the next poll doesn't take every entry for a
         * changed one.
         */
    }
}

/**
 * Calls `listener` whenever the skill records a review's status. What the file held when the first
 * listener was added counts as unchanged. Returns a function that removes the listener, which stops
 * the polling once no listener is left.
 */
export function listenToManualReviewState(listener: ManualReviewListener) {
    manualReviewWatch.listeners = [
        ...manualReviewWatch.listeners,
        listener,
    ];
    if (!manualReviewWatch.stopPolling) {
        void pollManualReviewFile();
        manualReviewWatch.stopPolling = createBlockingInterval(pollManualReviewFile, {
            seconds: 2,
        }).clearInterval;
    }
    return () => {
        manualReviewWatch.listeners = manualReviewWatch.listeners.filter((existing) => {
            return existing !== listener;
        });
        if (!manualReviewWatch.listeners.length) {
            manualReviewWatch.stopPolling?.();
            manualReviewWatch.stopPolling = undefined;
            manualReviewWatch.previousEntries = undefined;
        }
    };
}
