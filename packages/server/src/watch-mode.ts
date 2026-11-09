import {
    ManualReviewStatus,
    PaneKind,
    PaneStatus,
    PrStatus,
    WatchModeStatus,
    type FolderInfo,
    type PullRequestBranch,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {assertWrap, check, waitUntil} from '@augment-vir/assert';
import {
    awaitedFilter,
    extractErrorMessage,
    getEnumValues,
    getObjectTypedEntries,
    log,
    PromiseQueue,
    removeDuplicates,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {doesPathContain} from '@augment-vir/node';
import {instanceName, normalizePath, writeFileAtomically} from 'agent-storm';
import {convertDuration} from 'date-vir';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {
    checkValidShape,
    defineShape,
    enumShape,
    nullableShape,
    parseJsonWithShape,
} from 'object-shape-tester';
import {isSafeBranchName} from './branch-name.js';
import {isClaudeAwaitingPermission, isClaudeReady} from './claude-activity.js';
import {
    manualReviewSkillDir,
    watchModeInstructionsPath,
    watchModePassDir,
    watchModeStatePath,
} from './file-paths.js';
import {recordFolderPrStatus} from './folder-info.js';
import {getCurrentBranch, getRepoSlug, isManualReviewHereCopy, tryGit} from './git.js';
import {RawPrState} from './github-raw-enums.js';
import {listenToAssigneeQueue, readViewerLogin} from './github-review-queue.js';
import {
    listenToManualReviewState,
    postedVerdictStatuses,
    readManualReviewState,
    reviewBranchPrefix,
    type ListedManualReviewEntry,
} from './manual-review-state.js';
import {getLivePaneSessionIds, getPaneSessionStatusLookup} from './pty.js';
import {hasReviewableChanges} from './push-review.js';
import {
    createFolderSession,
    findFolderSession,
    getFolderSessions,
    renameFolderSession,
} from './sessions.js';
import {loadSettings} from './settings.js';
import {
    fetchPrCheck,
    formatPrCheck,
    PrNeed,
    reviewRequestNoteMarker,
    runGhIn,
    type PrCheck,
} from './watch-pr-check.js';

/** Work an AI pass can be handed. The order is the order the pass does it in. */
enum WatchTask {
    LocalChanges = 'local changes',
    OpenPr = 'open the PR',
    MergeConflict = 'merge conflict',
    Tests = 'tests',
    Comments = 'comments',
    MergeBlocked = 'merge blocked',
    StuckChecks = 'stuck checks',
    LinearTicket = 'Linear ticket',
}

const watchTaskOrder = getEnumValues(WatchTask);

const needTasks: Record<PrNeed, WatchTask | undefined> = {
    [PrNeed.MergeConflict]: WatchTask.MergeConflict,
    [PrNeed.Comments]: WatchTask.Comments,
    [PrNeed.Tests]: WatchTask.Tests,
    /** Re-requested in code, before any pass. */
    [PrNeed.ReRequestReview]: undefined,
    [PrNeed.MergeBlocked]: WatchTask.MergeBlocked,
};

const watchEntryShape = defineShape({
    isEnabled: false,
    status: enumShape(WatchModeStatus),
    /** Why watch mode stopped or paused, or what it is waiting on. */
    message: '',
    /** Pushes since a human last stepped in. */
    pushCount: 0,
    /** The array's default holds one placeholder; {@link defaultEntry} starts it empty. */
    pushLog: [''],
    /** ISO time of the latest human review or comment already counted. */
    lastHumanActivityAt: '',
    /** False until the first check after watch mode is turned on. */
    hasChecked: false,
    /** Consecutive checks that found checks pending and nothing else to do. */
    pendingPolls: 0,
    /**
     * The PR state, from {@link createIdleStateKey}, that the last pass pushed nothing for. No pass
     * is sent again until the PR moves on from it.
     */
    idleStateKey: '',
    failureCount: 0,
    /** Passes in a row whose Watch tab exited before finishing. */
    exitedPassCount: 0,
    /** The AI tab passes run in. Empty until the first pass. */
    watchSessionId: '',
    /** Unix milliseconds. */
    lastCheckAt: 0,
    /** The pass the Watch tab is running. */
    pass: nullableShape({
        /** Unix milliseconds. */
        sentAt: 0,
        headSha: '',
        tasks: [enumShape(WatchTask)],
    }),
});

type WatchEntry = typeof watchEntryShape.runtimeType;

export type WatchModeDeps = {
    /** The sidebar's folders. */
    listFolders(): Promise<ReadonlyArray<Readonly<FolderInfo>>>;
    /** Starts the tab's process if it isn't running, the way opening its pane would. */
    spawnPane(params: Readonly<{folder: string; kind: PaneKind; sessionId: string}>): Promise<void>;
    /** Types `text` into a running tab and submits it. */
    sendPaneText(
        params: Readonly<{folder: string; kind: PaneKind; sessionId: string; text: string}>,
    ): Promise<void>;
};

const watchState: {
    entries: Readonly<Record<string, WatchEntry>>;
    /** Folders with a run in progress, so a slow run is never overlapped by the next one. */
    runningFolders: ReadonlyArray<string>;
    deps: WatchModeDeps | undefined;
} = {
    entries: {},
    runningFolders: [],
    deps: undefined,
};

const maxPushCount = 10;
const maxPendingPolls = 36;

/**
 * The shape's default, minus the placeholders a shape default carries for its array and nullable
 * fields.
 */
const defaultEntry: WatchEntry = {
    ...watchEntryShape.default,
    pushLog: [],
    pass: undefined,
};

/** What the sidebar shows for a folder. */
export function getWatchModeInfo(folder: string) {
    const entry = watchState.entries[folder];
    return {
        status: entry?.status || WatchModeStatus.Off,
        message: entry?.message || '',
    };
}

/** Keeps a slow save from landing after, and overwriting, a newer one. */
const saveQueue = new PromiseQueue();

async function saveEntries() {
    const contents = JSON.stringify(watchState.entries, undefined, 4);
    try {
        await saveQueue.add(async () => {
            await writeFileAtomically({
                path: watchModeStatePath,
                contents,
            });
        });
    } catch (error) {
        log.warning(`Failed to save watch mode state: ${extractErrorMessage(error)}`);
    }
}

async function updateEntry(folder: string, update: Readonly<Partial<WatchEntry>>) {
    watchState.entries = {
        ...watchState.entries,
        [folder]: {
            ...(watchState.entries[folder] || defaultEntry),
            ...update,
        },
    };
    await saveEntries();
    return watchState.entries[folder] || defaultEntry;
}

async function stopWatching({folder, message}: Readonly<{folder: string; message: string}>) {
    await updateEntry(folder, {
        isEnabled: false,
        status: WatchModeStatus.Off,
        message,
        pass: undefined,
    });
}

export async function setWatchMode({
    folder: folderPath,
    isEnabled,
}: Readonly<{
    folder: string;
    isEnabled: boolean;
}>) {
    const folder = normalizePath(folderPath);
    if (isEnabled) {
        await updateEntry(folder, {
            ...defaultEntry,
            watchSessionId: watchState.entries[folder]?.watchSessionId || '',
            isEnabled: true,
            status: WatchModeStatus.Watching,
            message: 'Checking the PR.',
        });
        void runFolder(folder);
    } else {
        /** A pass already running finishes in its tab; it just isn't followed up. */
        await stopWatching({
            folder,
            message: '',
        });
    }
}

/** Any folder a PR is reviewed in, whether `/manual-review here` or the Review tab made it. */
function isReviewFolder(folder: string) {
    return doesPathContain({
        potentialParentPath: manualReviewSkillDir,
        potentialChildPath: folder,
    });
}

/** The sidebar folder, outside review folders, checked out on the branch of the same repo. */
async function findReviewedCheckout({
    deps,
    branch,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    branch: Readonly<PullRequestBranch>;
}>) {
    const folders = await deps.listFolders();
    const candidates = await Promise.all(
        folders
            .filter((folder) => folder.branch === branch.branchName && !isReviewFolder(folder.path))
            .map(async (folder) => {
                const slug = await getRepoSlug(folder.path);
                return slug?.owner === branch.owner && slug.name === branch.repoName
                    ? folder.path
                    : undefined;
            }),
    );
    return candidates.find(check.isTruthy);
}

/** An unreadable settings file leaves automatic watch mode on, like the setting's default. */
async function isAutoWatchModeDisabled() {
    return !!(await loadSettings().catch(() => undefined))?.disableAutoWatchMode;
}

/**
 * Turns watch mode on in the checkout a `/manual-review here` review came from, once the review's
 * approval or change request posts.
 */
async function watchNewlyReviewedCheckouts({
    deps,
    changedEntries,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    changedEntries: ReadonlyArray<ListedManualReviewEntry>;
}>) {
    if (await isAutoWatchModeDisabled()) {
        return;
    }
    const hereCopyEntries = await awaitedFilter(changedEntries, async ({entry}) => {
        return (
            !!entry.folder &&
            !entry.isPending &&
            !!entry.status &&
            postedVerdictStatuses[entry.status] &&
            isReviewFolder(entry.folder) &&
            (await isManualReviewHereCopy(entry.folder))
        );
    });
    await Promise.all(
        hereCopyEntries.map(async (branch) => {
            const folder = await findReviewedCheckout({
                deps,
                branch,
            });
            if (folder && !watchState.entries[folder]?.isEnabled) {
                await setWatchMode({
                    folder,
                    isEnabled: true,
                });
            }
        }),
    );
}

/**
 * Turns watch mode on in the sidebar checkout of each PR in the Assignee list. Only a folder watch
 * mode has never tracked qualifies, so turning watch mode off, or it stopping on its own, sticks.
 */
async function watchAssignedCheckouts({
    deps,
    pullRequests,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>;
}>) {
    if (await isAutoWatchModeDisabled()) {
        return;
    }
    const folders = await Promise.all(
        pullRequests
            .filter((pullRequest) => pullRequest.branchName)
            .map(async (branch) => {
                return await findReviewedCheckout({
                    deps,
                    branch,
                });
            }),
    );
    await Promise.all(
        removeDuplicates(folders.filter(check.isTruthy).map((folder) => normalizePath(folder)))
            .filter((folder) => !watchState.entries[folder])
            .map(async (folder) => {
                await setWatchMode({
                    folder,
                    isEnabled: true,
                });
            }),
    );
}

/** Undefined when git fails. */
async function runGit(folder: string, args: ReadonlyArray<string>) {
    return (await tryGit(folder, args))?.trim();
}

/** How the checkout differs from the PR's head commit. */
async function readLocalState({
    folder,
    branch,
    headSha,
}: Readonly<{
    folder: string;
    branch: string;
    headSha: string;
}>) {
    const status = assertWrap.isDefined(
        await runGit(folder, [
            'status',
            '--porcelain',
        ]),
        `git status failed in ${folder}.`,
    );
    if (!headSha) {
        return {
            isDirty: !!status,
            aheadCount: 0,
            behindCount: 0,
            localHeadSha: '',
        };
    }
    /** The PR's head commit may have been pushed from elsewhere, so it isn't always local yet. */
    await runGit(folder, [
        'fetch',
        '--quiet',
        'origin',
        branch,
    ]);
    const counts = assertWrap
        .isDefined(
            await runGit(folder, [
                'rev-list',
                '--left-right',
                '--count',
                `HEAD...${headSha}`,
            ]),
            `Couldn't compare ${folder} with the PR's head commit.`,
        )
        .split(/\s+/)
        .map(Number);
    return {
        isDirty: !!status,
        aheadCount: counts[0] || 0,
        behindCount: counts[1] || 0,
        localHeadSha: assertWrap.isDefined(
            await runGit(folder, [
                'rev-parse',
                'HEAD',
            ]),
            `git rev-parse HEAD failed in ${folder}.`,
        ),
    };
}

async function readDefaultBranch(folder: string) {
    const originHead = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        'origin/HEAD',
    ]);
    return (originHead || '').replace(/^origin\//, '');
}

/**
 * True when the push only replayed the PR's commits onto a newer base: the old head is not an
 * ancestor of the new one, and both heads carry the same commit subjects in the same order. A
 * rebase keeps each commit's original message, so a push that also adds a fix commit is not one.
 * Anything git can't answer (such as an old head that never reached this checkout) counts as a real
 * push.
 */
async function isRebaseOnlyPush({
    folder,
    baseBranch,
    oldHeadSha,
    newHeadSha,
}: Readonly<{
    folder: string;
    baseBranch: string;
    oldHeadSha: string;
    newHeadSha: string;
}>) {
    if (!isSafeBranchName(baseBranch)) {
        log.warning(
            `Treating a push to ${folder} as real: unsafe base branch name ${JSON.stringify(baseBranch)}.`,
        );
        return false;
    }
    const isFetched =
        (await runGit(folder, [
            'fetch',
            '--quiet',
            'origin',
            baseBranch,
        ])) != undefined;
    const isFastForward =
        (await runGit(folder, [
            'merge-base',
            '--is-ancestor',
            oldHeadSha,
            newHeadSha,
        ])) != undefined;
    if (!isFetched || isFastForward) {
        return false;
    }
    const [
        oldSubjects,
        newSubjects,
    ] = await Promise.all(
        [
            oldHeadSha,
            newHeadSha,
        ].map(async (headSha) => {
            return await runGit(folder, [
                'log',
                '--format=%s',
                `origin/${baseBranch}..${headSha}`,
            ]);
        }),
    );
    return !!newSubjects && oldSubjects === newSubjects;
}

/**
 * Also leaves a file comment on the PR's first file with `reason`, for the reviewers to resolve.
 * The comment goes first: GitHub files it as a review by the account posting it, and that review
 * clears the account's own request when the account is one of the reviewers.
 */
async function requestReviews({
    folder,
    prCheck,
    logins,
    reason,
}: Readonly<{
    folder: string;
    prCheck: Readonly<PrCheck>;
    logins: ReadonlyArray<string>;
    reason: string;
}>) {
    const slug = await getRepoSlug(folder);
    /** GitHub rejects a review request for the PR's author. */
    const newReviewers = logins.filter((login) => {
        return login !== prCheck.authorLogin && !prCheck.requestedReviewers.includes(login);
    });
    if (!slug || !newReviewers.length || !watchState.entries[folder]?.isEnabled) {
        return;
    }
    try {
        const firstFile = (
            await runGhIn(folder, [
                'api',
                `repos/${slug.owner}/${slug.name}/pulls/${prCheck.number}/files?per_page=1`,
                '--jq',
                '.[0].filename',
            ])
        ).trim();
        if (firstFile) {
            await runGhIn(folder, [
                'api',
                '-X',
                'POST',
                `repos/${slug.owner}/${slug.name}/pulls/${prCheck.number}/comments`,
                '-f',
                `body=${[
                    [
                        'AI: Re-requested review from ',
                        newReviewers.map((login) => '@' + login).join(', '),
                        ': ',
                        reason,
                    ].join(''),
                    reviewRequestNoteMarker,
                ].join('\n\n')}`,
                '-f',
                `commit_id=${prCheck.headSha}`,
                '-f',
                `path=${firstFile}`,
                '-f',
                'subject_type=file',
            ]);
        }
    } catch (error) {
        log.warning(
            `Failed to explain the review request on ${prCheck.url}: ${extractErrorMessage(error)}`,
        );
    }
    await runGhIn(folder, [
        'api',
        '-X',
        'POST',
        `repos/${slug.owner}/${slug.name}/pulls/${prCheck.number}/requested_reviewers`,
        ...newReviewers.flatMap((login) => {
            return [
                '-f',
                `reviewers[]=${login}`,
            ];
        }),
    ]);
}

/** Squash when the repo allows it, else a merge commit, else rebase. */
async function mergePr({folder, prCheck}: Readonly<{folder: string; prCheck: Readonly<PrCheck>}>) {
    const allowed = parseJsonWithShape(
        await runGhIn(folder, [
            'repo',
            'view',
            '--json',
            'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed',
        ]),
        defineShape({
            squashMergeAllowed: false,
            mergeCommitAllowed: false,
            rebaseMergeAllowed: false,
        }),
    );
    const method = allowed.squashMergeAllowed
        ? '--squash'
        : allowed.mergeCommitAllowed
          ? '--merge'
          : '--rebase';
    /** Pinned to the head commit that was checked, so a push that lands meanwhile isn't merged. */
    await runGhIn(folder, [
        'pr',
        'merge',
        String(prCheck.number),
        method,
        '--match-head-commit',
        prCheck.headSha,
    ]);
}

/** Linear identifiers in the PR's title, branch, or body, for the AI to confirm. */
function findTicketCandidates(prCheck: Readonly<PrCheck> | undefined, branch: string) {
    return removeDuplicates(
        [
            prCheck?.title || '',
            branch,
            ...[...(prCheck?.body || '').matchAll(/linear\.app\/\S*?\/issue\/([a-z]+-\d+)/gi)].map(
                (match) => match[1] || '',
            ),
        ]
            .flatMap((text) => text.match(/\b[a-z]+-\d+/gi) || [])
            .map((candidate) => candidate.toUpperCase()),
    );
}

async function ensureWatchSession({
    folder,
    entry,
}: Readonly<{
    folder: string;
    entry: Readonly<WatchEntry>;
}>) {
    const sessions = await getFolderSessions(folder);
    if (sessions.ai.some((session) => session.id === entry.watchSessionId)) {
        return entry.watchSessionId;
    }
    const created = (
        await createFolderSession({
            folder,
            kind: PaneKind.Ai,
        })
    ).ai.at(-1);
    if (!created) {
        throw new Error('Failed to create a Watch tab.');
    }
    await renameFolderSession({
        folder,
        kind: PaneKind.Ai,
        sessionId: created.id,
        name: 'Watch',
    });
    await updateEntry(folder, {
        watchSessionId: created.id,
    });
    return created.id;
}

async function readWatchSessionStatus({
    folder,
    sessionId,
}: Readonly<{folder: string; sessionId: string}>) {
    const lookup = await getPaneSessionStatusLookup();
    return (
        lookup(folder).find((session) => {
            return session.kind === PaneKind.Ai && session.sessionId === sessionId;
        })?.status || PaneStatus.None
    );
}

/** Whether a tab in this state is in the middle of something a pass mustn't interrupt. */
const busyStatuses: Readonly<Record<PaneStatus, boolean>> = {
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: false,
    [PaneStatus.Exited]: false,
    [PaneStatus.None]: false,
};

async function startPass({
    deps,
    folder,
    entry,
    tasks,
    prCheck,
    branch,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    folder: string;
    entry: Readonly<WatchEntry>;
    tasks: ReadonlyArray<WatchTask>;
    prCheck: Readonly<PrCheck> | undefined;
    branch: string;
}>) {
    const sessionId = await ensureWatchSession({
        folder,
        entry,
    });
    const conversationId = (
        await findFolderSession({
            folder,
            kind: PaneKind.Ai,
            sessionId,
        })
    )?.conversationId;
    if (conversationId && (await isClaudeAwaitingPermission(conversationId))) {
        await updateEntry(folder, {
            status: WatchModeStatus.Paused,
            message: 'Waiting for you to answer the prompt in the Watch tab.',
        });
        return;
    } else if (
        busyStatuses[
            await readWatchSessionStatus({
                folder,
                sessionId,
            })
        ]
    ) {
        await updateEntry(folder, {
            status: WatchModeStatus.Working,
            message: 'Waiting for the Watch tab to finish what it is doing.',
        });
        return;
    }
    const orderedTasks = watchTaskOrder.filter((task) => tasks.includes(task));
    const ticketCandidates = findTicketCandidates(prCheck, branch);
    /**
     * A new path every pass. With the same path each time, a long-running Watch tab answered from
     * the copy it read in an earlier pass instead of reading the file again.
     */
    const passDir = join(watchModePassDir, createPassFileName(folder));
    const passFilePath = join(passDir, `${Date.now()}.md`);
    await rm(passDir, {
        recursive: true,
        force: true,
    });
    await mkdir(passDir, {
        recursive: true,
    });
    await writeFile(
        passFilePath,
        [
            '# Watch mode pass',
            '',
            `checkout: ${folder}`,
            `branch: ${branch}`,
            '',
            '## Tasks',
            '',
            ...orderedTasks.map((task) => {
                const ticketNote = ticketCandidates.length
                    ? [
                          'candidates to confirm',
                          ticketCandidates.join(', '),
                      ].join(': ')
                    : 'no candidates found';
                return task === WatchTask.LinearTicket ? `- ${task}: ${ticketNote}` : `- ${task}`;
            }),
            '',
            '## PR check',
            '',
            prCheck ? formatPrCheck(prCheck) : 'The branch has no PR yet.',
            '',
        ].join('\n'),
    );
    if (!(await getLivePaneSessionIds(folder, PaneKind.Ai)).includes(sessionId)) {
        await deps.spawnPane({
            folder,
            kind: PaneKind.Ai,
            sessionId,
        });
    }
    /** Watch mode may have been turned off while the pass file was being written. */
    if (!watchState.entries[folder]?.isEnabled) {
        return;
    }
    /** One line, since a typed newline would submit the prompt early. */
    await deps.sendPaneText({
        folder,
        kind: PaneKind.Ai,
        sessionId,
        text: `Agent-storm watch mode pass for: ${orderedTasks.join(', ')}. Read this pass's new file ${passFilePath} and follow ${watchModeInstructionsPath} for its tasks and PR check.`,
    });
    await updateEntry(folder, {
        status: WatchModeStatus.Working,
        message: `Working on: ${orderedTasks.join(', ')}.`,
        pass: {
            sentAt: Date.now(),
            headSha: prCheck?.headSha || '',
            tasks: orderedTasks,
        },
    });
}

/** Folder paths turned into one safe file name. */
function createPassFileName(folder: string) {
    return folder.replaceAll(/[^\w.-]+/g, '_').replace(/^_+/, '');
}

/** How a pass stands given its Watch tab's status. Undefined while the pass is still running. */
const passResults: Readonly<
    Record<PaneStatus, (sentAt: number) => {isExited: boolean} | undefined>
> = {
    [PaneStatus.Busy]() {
        return undefined;
    },
    [PaneStatus.Stalled]() {
        return undefined;
    },
    [PaneStatus.Exited]() {
        return {
            isExited: true,
        };
    },
    [PaneStatus.None]() {
        return {
            isExited: true,
        };
    },
    [PaneStatus.Idle](sentAt) {
        /** The turn may not have registered as busy yet right after the prompt went in. */
        return Date.now() - sentAt <
            convertDuration(
                {
                    seconds: 30,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds
            ? undefined
            : {
                  isExited: false,
              };
    },
};

/** Undefined while the pass is still running. */
async function readPassResult({
    folder,
    entry,
}: Readonly<{folder: string; entry: Readonly<WatchEntry>}>) {
    if (!entry.pass) {
        return undefined;
    }
    const status = await readWatchSessionStatus({
        folder,
        sessionId: entry.watchSessionId,
    });
    return passResults[status](entry.pass.sentAt);
}

/**
 * Compacts the Watch tab once a pass ends, since the next pass starts from a fresh PR check and
 * needs none of this one's working detail.
 */
async function compactWatchSession({
    deps,
    folder,
    sessionId,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    folder: string;
    sessionId: string;
}>) {
    const conversationId = (
        await findFolderSession({
            folder,
            kind: PaneKind.Ai,
            sessionId,
        })
    )?.conversationId;
    /** The next pass pauses on the prompt too, so there's no need to stop watch mode over it. */
    if (conversationId && (await isClaudeAwaitingPermission(conversationId))) {
        return;
    }
    await deps.sendPaneText({
        folder,
        kind: PaneKind.Ai,
        sessionId,
        text: '/compact',
    });
    try {
        await waitUntil.isTrue(
            async () => {
                return (
                    !!conversationId &&
                    (await isClaudeReady(conversationId)) &&
                    !busyStatuses[
                        await readWatchSessionStatus({
                            folder,
                            sessionId,
                        })
                    ]
                );
            },
            {
                interval: {
                    seconds: 2,
                },
                timeout: {
                    minutes: 3,
                },
            },
        );
    } catch {
        /** A slow compaction only delays the next pass's prompt, which Claude queues. */
    }
}

/**
 * Everything whose change could give a pass that found nothing to push something new to work on.
 * Pending checks count only as a yes or no, so a pass that waited on them gets one more look once
 * they all finish.
 */
function createIdleStateKey(prCheck: Readonly<PrCheck>) {
    return JSON.stringify([
        prCheck.headSha,
        prCheck.needs,
        prCheck.failingChecks,
        prCheck.unresolvedThreads.map((thread) => `${thread.id} ${thread.status}`),
        prCheck.pendingCount > 0,
        prCheck.humanActivityAt,
    ]);
}

/** A manual review in one of these holds back the merge until it's done. */
const inProgressReviewStatuses: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Started]: true,
    [ManualReviewStatus.PostFailed]: true,
    [ManualReviewStatus.Approved]: false,
    [ManualReviewStatus.RequestedChanges]: false,
    [ManualReviewStatus.Commented]: false,
    [ManualReviewStatus.Aborted]: false,
};

/** Undefined for a PR that's still open. */
const closedPrDescriptions: Readonly<Record<RawPrState, string | undefined>> = {
    [RawPrState.Open]: undefined,
    [RawPrState.Merged]: 'merged',
    [RawPrState.Closed]: 'closed',
};

async function checkFolder({
    deps,
    folder,
    entry,
    finishedPass,
}: Readonly<{
    deps: Readonly<WatchModeDeps>;
    folder: string;
    entry: Readonly<WatchEntry>;
    finishedPass: WatchEntry['pass'];
}>) {
    const branch = await getCurrentBranch(folder);
    const slug = await getRepoSlug(folder);
    if (!branch) {
        await stopWatching({
            folder,
            message: 'HEAD is detached, so there is no PR to watch.',
        });
        return;
    } else if (!isSafeBranchName(branch)) {
        log.warning(`Not watching ${folder}: unsafe branch name ${JSON.stringify(branch)}.`);
        await stopWatching({
            folder,
            message: 'The branch name has characters watch mode does not allow.',
        });
        return;
    } else if (isReviewFolder(folder) || branch.startsWith(reviewBranchPrefix)) {
        await stopWatching({
            folder,
            message: 'This is a manual-review copy, not a branch to watch.',
        });
        return;
    } else if (!slug) {
        await stopWatching({
            folder,
            message: 'This checkout has no GitHub remote.',
        });
        return;
    }
    const manualReview = await readManualReviewState({
        owner: slug.owner,
        repoName: slug.name,
        branchName: branch,
    });
    /**
     * The review runs in its own checkout, so passes can keep pushing fixes under it. Only the
     * merge waits for the verdict.
     */
    const isManualReviewOpen =
        !!manualReview && (manualReview.isPending || inProgressReviewStatuses[manualReview.status]);
    const viewerLogin = await readViewerLogin();
    const prCheck = await fetchPrCheck({
        folder,
        owner: slug.owner,
        repoName: slug.name,
        viewerLogin,
    });
    const local = await readLocalState({
        folder,
        branch,
        headSha: prCheck?.headSha || '',
    });
    const isFirstCheck = !entry.hasChecked;
    const ticketTasks =
        isFirstCheck && !findTicketCandidates(prCheck, branch).length
            ? [WatchTask.LinearTicket]
            : [];
    const localTasks = local.isDirty || local.aheadCount > 0 ? [WatchTask.LocalChanges] : [];
    await updateEntry(folder, {
        hasChecked: true,
        failureCount: 0,
    });

    if (!prCheck) {
        if (branch === (await readDefaultBranch(folder))) {
            await stopWatching({
                folder,
                message: "This is the repo's default branch, so there is no PR to open.",
            });
            return;
        }
        await startPass({
            deps,
            folder,
            entry,
            tasks: [
                WatchTask.OpenPr,
                WatchTask.LinearTicket,
            ],
            prCheck,
            branch,
        });
        return;
    }
    const closedDescription = closedPrDescriptions[prCheck.state];
    if (closedDescription) {
        await stopWatching({
            folder,
            message: `PR #${prCheck.number} was ${closedDescription}.`,
        });
        return;
    }

    const hasNewHumanActivity = prCheck.humanActivityAt > entry.lastHumanActivityAt;
    const isNewPush = !!finishedPass && prCheck.headSha !== finishedPass.headSha;
    const pushCount = (hasNewHumanActivity ? 0 : entry.pushCount) + (isNewPush ? 1 : 0);
    const pushLog = [
        ...(hasNewHumanActivity ? [] : entry.pushLog),
        ...(isNewPush
            ? [
                  `${prCheck.headSha.slice(0, 7)}: ${finishedPass.tasks.join(', ')}`,
              ]
            : []),
    ];
    const idleStateKey =
        finishedPass && !isNewPush ? createIdleStateKey(prCheck) : entry.idleStateKey;
    await updateEntry(folder, {
        pushCount,
        pushLog,
        idleStateKey,
        lastHumanActivityAt: hasNewHumanActivity
            ? prCheck.humanActivityAt
            : entry.lastHumanActivityAt,
    });
    if (
        isNewPush &&
        !(await isRebaseOnlyPush({
            folder,
            baseBranch: prCheck.baseBranch,
            oldHeadSha: finishedPass.headSha,
            newHeadSha: prCheck.headSha,
        })) &&
        (await hasReviewableChanges({
            folder,
            baseBranch: prCheck.baseBranch,
            oldHeadSha: finishedPass.headSha,
            newHeadSha: prCheck.headSha,
        }))
    ) {
        /** The push changed code the current user hasn't seen. */
        await requestReviews({
            folder,
            prCheck,
            logins: [viewerLogin],
            reason: `watch mode pushed ${prCheck.headSha.slice(0, 7)} for ${finishedPass.tasks.join(', ')}, which changed code you have not reviewed.`,
        });
    }
    if (prCheck.reReviewLogins.length) {
        await requestReviews({
            folder,
            prCheck,
            logins: prCheck.reReviewLogins,
            reason: 'none of the threads from your changes-requested review is still unresolved, so it is ready for another look.',
        });
    }

    if (pushCount >= maxPushCount) {
        await stopWatching({
            folder,
            message: [
                `Stopped after ${maxPushCount} pushes without a human stepping in.`,
                prCheck.failingChecks.length
                    ? `Still failing: ${prCheck.failingChecks.join(', ')}.`
                    : '',
                `Pushes: ${pushLog.join('; ')}.`,
            ]
                .filter(check.isTruthy)
                .join(' '),
        });
        return;
    } else if (local.behindCount > 0) {
        /**
         * A rebase resets the local branch onto the new base before its force-push lands, which
         * reads as diverged until the push catches the PR up.
         */
        await updateEntry(folder, {
            status: WatchModeStatus.Watching,
            message:
                'Waiting for the local branch to catch up with the PR. If it has truly diverged, sync it by hand.',
        });
        return;
    } else if (prCheck.isAwaitingViewerReview) {
        await updateEntry(folder, {
            status: WatchModeStatus.Watching,
            message: 'Waiting for your review. The PR is in your Review tab.',
        });
        return;
    }

    const needTaskList = prCheck.needs.map((need) => needTasks[need]).filter(check.isTruthy);
    if (needTaskList.length && idleStateKey === createIdleStateKey(prCheck)) {
        await updateEntry(folder, {
            status: WatchModeStatus.Watching,
            message: `The last pass found nothing to push for: ${needTaskList.join(', ')}. Waiting for the PR to change. Check the Watch tab.`,
        });
        return;
    } else if (needTaskList.length) {
        await startPass({
            deps,
            folder,
            entry,
            tasks: [
                ...needTaskList,
                ...localTasks,
                ...ticketTasks,
            ],
            prCheck,
            branch,
        });
        return;
    } else if (prCheck.isReadyToMerge) {
        if (localTasks.length || local.localHeadSha !== prCheck.headSha) {
            /** Merging now would strand the local work outside the PR. */
            await startPass({
                deps,
                folder,
                entry,
                tasks: [
                    ...localTasks,
                    ...ticketTasks,
                ],
                prCheck,
                branch,
            });
            return;
        } else if (isManualReviewOpen) {
            await updateEntry(folder, {
                status: WatchModeStatus.Watching,
                message: 'Ready to merge once your manual review of this branch is finished.',
            });
            return;
        } else if (watchState.entries[folder]?.isEnabled) {
            await mergePr({
                folder,
                prCheck,
            });
            await stopWatching({
                folder,
                message: `Merged PR #${prCheck.number}.`,
            });
            await recordFolderPrStatus({
                folder,
                slug,
                branchName: branch,
                prInfo: {
                    url: prCheck.url,
                    status: PrStatus.Merged,
                },
            });
            return;
        } else {
            return;
        }
    } else if (isFirstCheck && (localTasks.length || ticketTasks.length)) {
        await startPass({
            deps,
            folder,
            entry,
            tasks: [
                ...localTasks,
                ...ticketTasks,
            ],
            prCheck,
            branch,
        });
        return;
    }

    const pendingPolls =
        prCheck.pendingCount && !prCheck.isBlockedOnHuman ? entry.pendingPolls + 1 : 0;
    if (pendingPolls >= maxPendingPolls) {
        await updateEntry(folder, {
            pendingPolls: 0,
        });
        await startPass({
            deps,
            folder,
            entry,
            tasks: [WatchTask.StuckChecks],
            prCheck,
            branch,
        });
        return;
    }
    await updateEntry(folder, {
        status: WatchModeStatus.Watching,
        pendingPolls,
        message: prCheck.isBlockedOnHuman
            ? 'Waiting on a human to answer or 👍 a review thread.'
            : prCheck.pendingCount
              ? 'Waiting on checks.'
              : 'Waiting on reviews.',
    });
}

async function runFolder(folder: string) {
    const deps = watchState.deps;
    if (!deps || watchState.runningFolders.includes(folder)) {
        return;
    }
    watchState.runningFolders = [
        ...watchState.runningFolders,
        folder,
    ];
    try {
        const entry = watchState.entries[folder];
        if (!entry?.isEnabled) {
            return;
        }
        const passResult = await readPassResult({
            folder,
            entry,
        });
        if (entry.pass && !passResult) {
            return;
        } else if (passResult?.isExited && entry.exitedPassCount) {
            await stopWatching({
                folder,
                message: 'The Watch tab exited during two passes in a row.',
            });
            return;
        } else if (
            !passResult &&
            Date.now() - entry.lastCheckAt <
                convertDuration(
                    {
                        minutes: 5,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds
        ) {
            return;
        } else if (
            (await getPaneSessionStatusLookup())(folder).some((session) => {
                return session.kind === PaneKind.Ai && busyStatuses[session.status];
            })
        ) {
            /**
             * Another tab may be mid-rebase or mid-push, so the branch can look broken until it
             * finishes. A finished pass stays recorded so its push is still counted afterward.
             */
            await updateEntry(folder, {
                status: WatchModeStatus.Paused,
                message: "Waiting for this folder's AI tabs to finish.",
            });
            return;
        } else if (passResult) {
            await updateEntry(folder, {
                pass: undefined,
                exitedPassCount: passResult.isExited ? entry.exitedPassCount + 1 : 0,
            });
            /** An exited tab has nothing to compact, and the next pass restarts it. */
            if (!passResult.isExited) {
                await compactWatchSession({
                    deps,
                    folder,
                    sessionId: entry.watchSessionId,
                });
            }
        }
        const checkedEntry = await updateEntry(folder, {
            lastCheckAt: Date.now(),
        });
        await checkFolder({
            deps,
            folder,
            entry: checkedEntry,
            /** An exited pass may not have finished its tasks, so they get sent again. */
            finishedPass: passResult?.isExited ? undefined : entry.pass,
        });
    } catch (error) {
        const failureCount = (watchState.entries[folder]?.failureCount || 0) + 1;
        const message = extractErrorMessage(error);
        log.warning(`Watch mode failed for ${folder}: ${message}`);
        if (failureCount >= 2) {
            await stopWatching({
                folder,
                message: `Stopped after an error: ${message}`,
            });
        } else {
            await updateEntry(folder, {
                failureCount,
            });
        }
    } finally {
        watchState.runningFolders = watchState.runningFolders.filter(
            (runningFolder) => runningFolder !== folder,
        );
    }
}

async function loadEntries() {
    const contents = await readFile(watchModeStatePath, 'utf8').catch(() => undefined);
    if (!contents) {
        return {};
    }
    try {
        const stored: unknown = JSON.parse(contents);
        return check.isObject(stored)
            ? typedObjectFromEntries(
                  getObjectTypedEntries(stored).flatMap(
                      ([
                          folder,
                          entry,
                      ]) => {
                          /** Entries saved before a field existed get its default. */
                          const withDefaults = check.isObject(entry)
                              ? {
                                    ...defaultEntry,
                                    ...entry,
                                }
                              : entry;
                          return checkValidShape(withDefaults, watchEntryShape)
                              ? [
                                    [
                                        String(folder),
                                        withDefaults,
                                    ] as const,
                                ]
                              : [];
                      },
                  ),
              )
            : {};
    } catch (error) {
        log.warning(`Ignoring unreadable watch mode state: ${extractErrorMessage(error)}`);
        return {};
    }
}

/**
 * Turns watch mode back on for folders it used to stop on its own and now keeps watching: after
 * passes in a row pushed nothing, and when only the user's review was left.
 */
async function resumeIdleStoppedFolders() {
    if (await isAutoWatchModeDisabled()) {
        return;
    }
    await Promise.all(
        getObjectTypedEntries(watchState.entries)
            .filter(
                ([
                    ,
                    entry,
                ]) => {
                    return (
                        !entry.isEnabled &&
                        [
                            'passes in a row pushed nothing',
                            'Only your review is left',
                        ].some((message) => entry.message.includes(message))
                    );
                },
            )
            .map(async ([folder]) => {
                const isFolder = await stat(folder)
                    .then((stats) => stats.isDirectory())
                    .catch(() => false);
                if (isFolder) {
                    await setWatchMode({
                        folder,
                        isEnabled: true,
                    });
                }
            }),
    );
}

/**
 * Agent-storm's built-in `/watch-pr`: polls each watched folder's PR, merges it once it's ready,
 * and hands the work it can't do in code to an AI pass in the folder's Watch tab. Survives server
 * restarts, picking a pass that was running back up where it left off.
 */
export async function startWatchMode(deps: Readonly<WatchModeDeps>) {
    watchState.deps = deps;
    watchState.entries = await loadEntries();
    await resumeIdleStoppedFolders();
    /**
     * A named instance is a debug copy using the user's own GitHub login. Watching PRs it wasn't
     * asked to would push to and merge the user's real PRs.
     */
    if (!instanceName) {
        listenToManualReviewState(async (changedEntries) => {
            await watchNewlyReviewedCheckouts({
                deps,
                changedEntries,
            });
        });
        listenToAssigneeQueue(async (pullRequests) => {
            await watchAssignedCheckouts({
                deps,
                pullRequests,
            });
        });
    }
    setInterval(
        () => {
            getObjectTypedEntries(watchState.entries)
                .filter(
                    ([
                        ,
                        entry,
                    ]) => entry.isEnabled,
                )
                .forEach(([folder]) => {
                    void runFolder(folder);
                });
        },
        convertDuration(
            {
                seconds: 10,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
}
