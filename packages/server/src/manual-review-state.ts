import {
    manualReviewStateShape,
    ManualReviewStatus,
    reviewCommentShape,
    type ManualReviewState,
    type PullRequestBranch,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    createBlockingInterval,
    extractErrorMessage,
    getObjectTypedEntries,
    log,
    type MaybePromise,
} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {
    checkValidShape,
    defineShape,
    intersectShape,
    parseJsonWithShape,
    partialShape,
    recordShape,
    unknownShape,
} from 'object-shape-tester';
import {manualReviewStatePath} from './file-paths.js';

/** The prefix the manual-review skill puts on the branch it reviews a PR's head branch on. */
export const reviewBranchPrefix = 'review__';

/**
 * The skill's state file, `<owner>/<repo>` then head branch. Entries are left unchecked here so a
 * rewrite keeps every field, including ones agent-storm doesn't know about.
 */
const manualReviewFileShape = defineShape(
    recordShape({
        keys: '',
        values: recordShape({
            keys: '',
            values: unknownShape(),
        }),
    }),
);

export type ManualReviewFile = typeof manualReviewFileShape.runtimeType;

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
            comments: [
                reviewCommentShape,
            ],
        }),
    ),
);

export type ManualReviewEntry = typeof manualReviewEntryShape.runtimeType;

/** `{}` when the skill hasn't written the file yet. Throws when it can't be parsed. */
export async function readManualReviewFile(statePath: string) {
    const contents = await readFileIfExists(statePath);
    return contents == undefined ? {} : parseJsonWithShape(contents, manualReviewFileShape);
}

/** Every entry in the file that has the shape of one, along with the branch it's recorded under. */
export function listManualReviewEntries(file: Readonly<ManualReviewFile>) {
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
                    return checkValidShape(entry, manualReviewEntryShape)
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

export type ListedManualReviewEntry = ReturnType<typeof listManualReviewEntries>[number];

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
    isStarted: boolean;
} = {
    listeners: [],
    previousEntries: undefined,
    isStarted: false,
};

function toEntryKey({owner, repoName, branchName}: Readonly<PullRequestBranch>) {
    return [
        owner,
        repoName,
        branchName,
    ].join('/');
}

async function pollManualReviewFile() {
    try {
        const entries = listManualReviewEntries(await readManualReviewFile(manualReviewStatePath));
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
 * listener was added counts as unchanged.
 */
export function listenToManualReviewState(listener: ManualReviewListener) {
    manualReviewWatch.listeners = [
        ...manualReviewWatch.listeners,
        listener,
    ];
    if (manualReviewWatch.isStarted) {
        return;
    }
    manualReviewWatch.isStarted = true;
    void pollManualReviewFile();
    createBlockingInterval(pollManualReviewFile, {
        seconds: 2,
    });
}
