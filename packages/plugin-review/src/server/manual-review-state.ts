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
    type UnknownObject,
} from '@augment-vir/common';
import {doesPathContain} from '@augment-vir/node';
import {
    hasErrorCode,
    listManualReviewEntries,
    manualReviewSkillDir,
    manualReviewStatePath,
    readManualReviewFile,
    runCommand,
    withManualReviewStateLock,
    writeFileAtomically,
} from 'agent-storm-util';
import {convertDuration, type AnyDuration} from 'date-vir';
import {lstat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
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

async function readManualReviewEntryLookup() {
    const file = await readManualReviewFile(manualReviewStatePath).catch(() => undefined);
    return ({owner, repoName, branchName}: Readonly<PullRequestBranch>) => {
        const entry = file?.[`${owner}/${repoName}`]?.[branchName];
        return checkValidShape(entry, manualReviewEntryShape) ? entry : undefined;
    };
}

/** Undefined when the skill never recorded the branch or its state file can't be read. */
export async function readManualReviewEntry(branch: Readonly<PullRequestBranch>) {
    return (await readManualReviewEntryLookup())(branch);
}

function toManualReviewState(entry: Readonly<ManualReviewEntry> | undefined) {
    return entry?.status && entry.isPending != undefined && entry.lastUpdatedAt != undefined
        ? ({
              status: entry.status,
              isPending: entry.isPending,
              lastUpdatedAt: entry.lastUpdatedAt,
              headSha: entry.headSha,
          } satisfies ManualReviewState)
        : undefined;
}

/** Undefined until the skill records a status for the branch. */
export async function readManualReviewState(branch: Readonly<PullRequestBranch>) {
    return toManualReviewState(await readManualReviewEntry(branch));
}

export async function readManualReviewStateLookup() {
    const findEntry = await readManualReviewEntryLookup();
    return (branch: Readonly<PullRequestBranch>) => toManualReviewState(findEntry(branch));
}

/** Called with every entry whose status changed since the previous read of the state file. */
export type ManualReviewListener = (
    changedEntries: ReadonlyArray<ListedManualReviewEntry>,
) => MaybePromise<void>;

const manualReviewWatch: {
    listeners: ReadonlyArray<ManualReviewListener>;
    /** Undefined until the first successful read. */
    previousEntries: ReadonlyMap<string, ManualReviewEntry> | undefined;
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
        settledStatus: ManualReviewStatus.Aborted,
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

function runsCleanupScript(status: ManualReviewStatus, command: string) {
    return !!pendingStatusCleanups[status]?.scripts.some((script) => command.includes(script));
}

/** Each process's working directory, by pid. A pid whose directory can't be read is left out. */
async function readProcessFolders(processIds: ReadonlyArray<string>) {
    if (!processIds.length) {
        return {};
    }
    /** `lsof` exits 1 when it can't read any one of the processes, even after printing the rest. */
    const output = await runCommand(
        'lsof',
        [
            '-a',
            '-d',
            'cwd',
            '-Fn',
            '-p',
            processIds.join(','),
        ],
        {
            timeout: {
                seconds: 5,
            },
        },
    ).then(
        ({stdout}) => stdout,
        (error: unknown) => {
            return check.hasKey(error, 'stdout') && check.isString(error.stdout)
                ? error.stdout
                : '';
        },
    );
    return parseLsofFolders(output);
}

/**
 * Whether a process working in `cwd` runs inside the review folder `folder`, the folder itself
 * included. `doesPathContain` alone is false for equal paths, and review scripts run from the
 * folder itself.
 */
export function isInReviewFolder({folder, cwd}: Readonly<{folder: string; cwd: string}>) {
    return (
        cwd === folder ||
        doesPathContain({
            potentialParentPath: folder,
            potentialChildPath: cwd,
        })
    );
}

/** Parses the `p<pid>` and `n<path>` lines of `lsof -Fn` into each pid's path. */
export function parseLsofFolders(output: string) {
    return output.split('\n').reduce<{
        pid: string | undefined;
        folders: Readonly<Record<string, string>>;
    }>(
        (parsed, line) => {
            if (line.startsWith('p')) {
                return {
                    ...parsed,
                    pid: line.slice(1),
                };
            } else if (line.startsWith('n') && parsed.pid) {
                return {
                    ...parsed,
                    folders: {
                        ...parsed.folders,
                        [parsed.pid]: line.slice(1),
                    },
                };
            } else {
                return parsed;
            }
        },
        {
            pid: undefined,
            folders: {},
        },
    ).folders;
}

/**
 * Rewrites listed entries in the state file under its lock. `update` returns `undefined` to leave
 * an entry alone. An entry a run has rewritten since it was listed is skipped.
 */
async function updateUnchangedEntries({
    entries,
    update,
}: Readonly<{
    entries: ReadonlyArray<ListedManualReviewEntry>;
    update: (
        stored: Readonly<UnknownObject>,
        listed: Readonly<ListedManualReviewEntry>,
    ) => UnknownObject | undefined;
}>) {
    await withManualReviewStateLock({
        statePath: manualReviewStatePath,
        async callback() {
            const file = await readManualReviewFile(manualReviewStatePath);
            const updated = entries.reduce((current, listed) => {
                const repoKey = [
                    listed.owner,
                    listed.repoName,
                ].join('/');
                const stored = current[repoKey]?.[listed.branchName];
                const updatedEntry =
                    check.isObject(stored) && stored.lastUpdatedAt === listed.entry.lastUpdatedAt
                        ? update(stored, listed)
                        : undefined;
                return updatedEntry
                    ? {
                          ...current,
                          [repoKey]: {
                              ...current[repoKey],
                              [listed.branchName]: updatedEntry,
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
}

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
    const {stdout: processList} = await runCommand(
        'ps',
        [
            '-axo',
            'pid=,command=',
        ],
        {
            timeout: {
                seconds: 5,
            },
        },
    );
    const scriptProcesses = processList
        .split('\n')
        .map((line) => {
            const [
                pid = '',
                ...command
            ] = line.trim().split(/\s+/);
            return {
                pid,
                command: command.join(' '),
            };
        })
        .filter(({command}) => {
            return candidates.some((listed) => {
                return !!listed.entry.status && runsCleanupScript(listed.entry.status, command);
            });
        });
    const folderByPid = await readProcessFolders(scriptProcesses.map(({pid}) => pid));
    /**
     * Several reviews often run at once, so a script only keeps an entry pending while it runs in
     * that entry's review folder.
     */
    const orphaned = candidates.filter((listed) => {
        const status = listed.entry.status;
        const folder = listed.entry.folder;
        return (
            !!status &&
            !scriptProcesses.some(({pid, command}) => {
                const cwd = folderByPid[pid];
                return (
                    runsCleanupScript(status, command) &&
                    (!folder ||
                        !cwd ||
                        isInReviewFolder({
                            folder,
                            cwd,
                        }))
                );
            })
        );
    });
    if (!orphaned.length) {
        return;
    }
    await updateUnchangedEntries({
        entries: orphaned,
        update(stored, listed) {
            const cleanup = listed.entry.status && pendingStatusCleanups[listed.entry.status];
            return cleanup && stored.isPending === true
                ? {
                      ...stored,
                      status: cleanup.settledStatus,
                      isPending: false,
                  }
                : undefined;
        },
    });
    log.info(
        `Settled pending manual reviews that no script is working on: ${orphaned
            .map((listed) => listed.branchName)
            .join(', ')}`,
    );
}

/** A review in one of these still needs its folder, to read the PR in and to post from. */
const folderReviewStatuses: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Started]: true,
    [ManualReviewStatus.PostFailed]: true,
    [ManualReviewStatus.Approved]: false,
    [ManualReviewStatus.RequestedChanges]: false,
    [ManualReviewStatus.Commented]: false,
    [ManualReviewStatus.Aborted]: false,
};

/**
 * Whether `folder` still holds a checkout. Only a missing path counts as gone, so a folder that
 * can't be read for another reason keeps its review.
 */
async function isCheckout(folder: string) {
    try {
        await lstat(join(folder, '.git'));
        return true;
    } catch (error) {
        return !hasErrorCode(error, 'ENOENT') && !hasErrorCode(error, 'ENOTDIR');
    }
}

/**
 * Aborts unfinished reviews whose folder is no longer a checkout, such as one deleted by hand to
 * free disk space. Their entry would otherwise keep saying the review is in progress, which leaves
 * the Review pane unable to start it again and the skill's abort script unable to run in it.
 */
async function abortReviewsWithoutFolder(entries: ReadonlyArray<ListedManualReviewEntry>) {
    const withoutFolder = (
        await Promise.all(
            entries.map(async (listed) => {
                const folder = listed.entry.folder;
                const isFolderGone =
                    !!folder &&
                    !!listed.entry.status &&
                    folderReviewStatuses[listed.entry.status] &&
                    !listed.entry.isPending &&
                    !(await isCheckout(folder));
                return isFolderGone
                    ? [
                          listed,
                      ]
                    : [];
            }),
        )
    ).flat();
    if (!withoutFolder.length) {
        return;
    }
    await updateUnchangedEntries({
        entries: withoutFolder,
        update(stored) {
            return {
                ...stored,
                status: ManualReviewStatus.Aborted,
                isPending: false,
                lastUpdatedAt: Date.now(),
            };
        },
    });
    log.info(
        `Aborted manual reviews whose folder is gone: ${withoutFolder
            .map((listed) => listed.branchName)
            .join(', ')}`,
    );
}

async function pollManualReviewFile(stopPolling: () => void) {
    if (manualReviewWatch.stopPolling !== stopPolling) {
        return;
    }
    try {
        const entries = listManualReviewEntries({
            file: await readManualReviewFile(manualReviewStatePath),
            entryShape: manualReviewEntryShape,
        });
        /** `ps` is missing on Windows, where the skill's bash scripts don't run either. */
        await clearOrphanedPendingEntries(entries).catch(() => undefined);
        await abortReviewsWithoutFolder(entries).catch((error: unknown) => {
            log.warning(
                `Failed to abort manual reviews whose folder is gone: ${extractErrorMessage(error)}`,
            );
        });
        if (manualReviewWatch.stopPolling !== stopPolling) {
            return;
        }
        const previousEntries = manualReviewWatch.previousEntries;
        manualReviewWatch.previousEntries = new Map<string, ManualReviewEntry>(
            entries.map((listed) => {
                return [
                    toEntryKey(listed),
                    listed.entry,
                ];
            }),
        );
        if (!previousEntries) {
            return;
        }
        const changedEntries = entries.filter((listed) => {
            const previous = previousEntries.get(toEntryKey(listed));
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
        const interval = createBlockingInterval(
            async () => {
                await initialPoll;
                await pollManualReviewFile(interval.clearInterval);
            },
            {
                seconds: 2,
            },
        );
        manualReviewWatch.stopPolling = interval.clearInterval;
        const initialPoll = pollManualReviewFile(interval.clearInterval);
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
