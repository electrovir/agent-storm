import {
    createFolderReviewPrompt,
    createManualReviewPrompt,
    ManualReviewStatus,
    PaneKind,
    PaneStatus,
    PrStatus,
    type PullRequestRef,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {waitUntil} from '@augment-vir/assert';
import {awaitedForEach, extractErrorMessage, log, removeDuplicates} from '@augment-vir/common';
import {tryGit} from 'agent-storm-util';
import {convertDuration, type AnyDuration} from 'date-vir';
import {readdir} from 'node:fs/promises';
import {
    listenToAssigneeQueue,
    listenToReviewQueue,
    readAssigneeQueue,
    readReviewQueue,
    resolveReviewFolder,
} from './github-review-queue.js';
import {readManualReviewEntry, readManualReviewState} from './manual-review-state.js';
import {readReviewHost} from './review-host.js';

/** An unreadable settings file leaves automatic reviews on, like the setting's default. */
async function isAutoManualReviewDisabled() {
    return !!(
        await readReviewHost()
            .loadSettings()
            .catch(() => undefined)
    )?.disableAutoManualReview;
}

export type ReviewAutoStartDeps = {
    /** Types `prompt` into the folder's first AI tab, starting that tab first if it isn't running. */
    launchFolderSession(params: Readonly<{folder: string; prompt: string}>): Promise<void>;
    /** Runs the repo's review init command in the review folder's shell tab. */
    runReviewInitCmd(pullRequest: Readonly<PullRequestRef>): Promise<void>;
};

/** Statuses of a PR that's no longer open, so has nothing left to review. */
export const finishedPrStatuses: Readonly<Record<PrStatus, boolean>> = {
    [PrStatus.None]: false,
    [PrStatus.AwaitingReview]: false,
    [PrStatus.ReviewStarted]: false,
    [PrStatus.ReReviewRequested]: false,
    [PrStatus.UnresolvedComments]: false,
    [PrStatus.ChangesRequested]: false,
    [PrStatus.Approved]: false,
    [PrStatus.OthersRequestedChanges]: false,
    [PrStatus.AwaitingOtherReviews]: false,
    [PrStatus.ChecksFailed]: false,
    [PrStatus.ReadyToMerge]: false,
    [PrStatus.Merged]: true,
    [PrStatus.Closed]: true,
};

const autoStartState: {
    /** PRs already looked at since the server started, so each is only tried once. */
    triedUrls: ReadonlyArray<string>;
    /**
     * `<url>@<head sha>` of each outdated review restarted or being checked, so each head is tried
     * once.
     */
    restartedHeads: ReadonlyArray<string>;
    /** When each PR's review was last launched from the Reviewer or Assignee list, by URL. */
    launchedAt: Readonly<Record<string, number>>;
    /** Each PR's resent failed verdicts since the server started, by URL. */
    failedPostRetries: Readonly<Record<string, {count: number; sentAt: number}>>;
} = {
    triedUrls: [],
    restartedHeads: [],
    launchedAt: {},
    failedPostRetries: {},
};

/**
 * How long a launched review gets to record itself before a launch that left no review is tried
 * again, so a failure that persists, such as GitHub's rate limit, isn't retried on every update.
 */
const retryGap = {
    milliseconds: 600_000,
} as const satisfies AnyDuration;

/** True for a PR that hasn't been launched, or was launched longer ago than the retry gap. */
function hasLaunchCooledDown(url: string) {
    const launchedAt = autoStartState.launchedAt[url];
    return launchedAt == undefined || Date.now() - launchedAt > retryGap.milliseconds;
}

/** Whether an AI tab in this state may still be running the review's start. */
const busyPaneStatuses: Readonly<Record<PaneStatus, boolean>> = {
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: false,
    [PaneStatus.Exited]: false,
    [PaneStatus.None]: false,
};

/**
 * Starts a manual review of every PR in the Reviewer or Assignee list without one, so each is ready
 * by the time it's opened, and of every Build folder's branch that just got a PR. A reviewed PR
 * whose review is requested again gets its review restarted. Runs whether or not any frontend is
 * open. Returns a function that stops it.
 */
export function startReviewAutoStart(deps: Readonly<ReviewAutoStartDeps>) {
    const stopListeners = [
        readReviewHost().listenToNewFolderPrs(({path, branch, prUrl, prStatus}) => {
            if (
                !branch ||
                !prUrl ||
                finishedPrStatuses[prStatus] ||
                autoStartState.triedUrls.includes(prUrl)
            ) {
                return;
            }
            autoStartState.triedUrls = [
                ...autoStartState.triedUrls,
                prUrl,
            ];
            void autoStartBuildReview({
                folder: path,
                branchName: branch,
                prUrl,
                deps,
            });
        }),
        listenToReviewQueue(createQueueListener(deps)),
        listenToAssigneeQueue(createQueueListener(deps)),
    ];
    /**
     * The queues only poll GitHub once something reads them. Polling starts before the read's pane
     * lookup, so a failing lookup can be ignored.
     */
    readReviewQueue().catch(() => undefined);
    readAssigneeQueue().catch(() => undefined);
    return () => {
        stopListeners.forEach((stopListener) => stopListener());
    };
}

/**
 * Restarts a finished review only when the viewer's review request is new since the list's previous
 * update, or, on the list's first update, when the verdict is older than
 * {@link postedVerdictListingLag}. Posting a verdict clears the request on GitHub, but the search
 * can keep listing it for an update or two, which would otherwise restart the review that was just
 * posted.
 */
function createQueueListener(deps: Readonly<ReviewAutoStartDeps>) {
    const queueState: {
        /** Undefined until the list's first update. */
        awaitingUrls: ReadonlyArray<string> | undefined;
    } = {
        awaitingUrls: undefined,
    };
    return (pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => {
        const previousAwaitingUrls = queueState.awaitingUrls;
        queueState.awaitingUrls = pullRequests
            .filter((pr) => pr.isAwaitingViewerReview)
            .map((pr) => pr.url);
        /** A PR from outside the repo would put a stranger's code and text in front of the AI. */
        const reviewablePrs = pullRequests.filter((pr) => {
            return pr.isAuthorTrusted && !pr.isViewerAuthor && !pr.isDraft;
        });
        const candidates = reviewablePrs
            .map((pr) => {
                return {
                    pullRequest: pr,
                    isReRequested:
                        !!previousAwaitingUrls &&
                        pr.isAwaitingViewerReview &&
                        !previousAwaitingUrls.includes(pr.url),
                    isAwaitingAtStartup: !previousAwaitingUrls && pr.isAwaitingViewerReview,
                };
            })
            .filter(({pullRequest, isReRequested}) => {
                return (
                    isReRequested ||
                    !autoStartState.triedUrls.includes(pullRequest.url) ||
                    (pullRequest.url in autoStartState.launchedAt &&
                        hasLaunchCooledDown(pullRequest.url))
                );
            });
        autoStartState.triedUrls = removeDuplicates([
            ...autoStartState.triedUrls,
            ...candidates.map(({pullRequest}) => pullRequest.url),
        ]);
        /** Starting an AI takes a while, and the queue's next update shouldn't wait on it. */
        void awaitedForEach(
            candidates,
            async ({pullRequest, isReRequested, isAwaitingAtStartup}) => {
                await autoStartReview({
                    pullRequest,
                    isReRequested,
                    isAwaitingAtStartup,
                    deps,
                });
            },
        );
        void awaitedForEach(reviewablePrs, async (pullRequest) => {
            await restartOutdatedReview({
                pullRequest,
                deps,
            });
            await retryFailedPost({
                pullRequest,
                deps,
            });
        });
    };
}

/**
 * The review's checkout when it was staged from an older head commit than the PR's current one and
 * the reviewer hasn't read any of it yet: no staged files (staging is how a file gets marked read)
 * and no comments stored from the diff pane. Reviews are stored by branch, so a review of an
 * earlier PR on the same branch doesn't count: its checkout is deleted once that PR closes.
 */
async function findUnreadOutdatedReviewFolder(pullRequest: Readonly<ReviewQueuePr>) {
    const review = await readManualReviewEntry(pullRequest);
    if (
        review?.status !== ManualReviewStatus.Started ||
        review.prNumber !== pullRequest.number ||
        review.isPending ||
        !review.headSha ||
        review.headSha === pullRequest.headSha ||
        !review.folder ||
        review.comments?.length
    ) {
        return undefined;
    }
    /** Undefined when git fails, such as for a folder that's gone. */
    const stagedFiles = await tryGit(review.folder, [
        'diff',
        '--cached',
        '--name-only',
    ]);
    return stagedFiles == undefined || stagedFiles.trim() ? undefined : review.folder;
}

/** Starts an unread review over on the PR's new head commit, once per head commit. */
async function restartOutdatedReview({
    pullRequest,
    deps,
}: Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    if (await isAutoManualReviewDisabled()) {
        return;
    }
    const restartKey = `${pullRequest.url}@${pullRequest.headSha}`;
    if (!pullRequest.headSha || autoStartState.restartedHeads.includes(restartKey)) {
        return;
    }
    /** Claimed before the checks, since the Reviewer and Assignee lists can both list the PR. */
    autoStartState.restartedHeads = [
        ...autoStartState.restartedHeads,
        restartKey,
    ];
    try {
        const folder = await findUnreadOutdatedReviewFolder(pullRequest);
        if (!folder) {
            /** The review can still become restartable for this head, such as once it stops pending. */
            autoStartState.restartedHeads = autoStartState.restartedHeads.filter((key) => {
                return key !== restartKey;
            });
            return;
        }
        await deps.launchFolderSession({
            folder,
            prompt: createManualReviewPrompt({
                pullRequest,
                folder,
            }),
        });
        log.info(
            `Restarted the manual review of ${pullRequest.url} on its new head ${pullRequest.headSha.slice(0, 7)}.`,
        );
    } catch (error) {
        log.warning(
            `Failed to restart the outdated manual review of ${pullRequest.url}: ${extractErrorMessage(error)}`,
        );
    }
}

/** How many times a failed verdict is sent again before it's left for the reviewer to retry. */
const maxFailedPostRetries = 3;

/**
 * Sends a verdict whose post failed again. Until it posts, the skill refuses to start the review
 * over, since starting would discard the comments that failed to post.
 */
async function retryFailedPost({
    pullRequest,
    deps,
}: Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    try {
        if (await isAutoManualReviewDisabled()) {
            return;
        }
        const review = await readManualReviewEntry(pullRequest);
        if (
            review?.status !== ManualReviewStatus.PostFailed ||
            review.isPending ||
            review.prNumber !== pullRequest.number ||
            !review.failedVerdict ||
            !review.folder ||
            busyPaneStatuses[
                (await readReviewHost().getPaneStatusLookup())(review.folder, PaneKind.Ai)
            ]
        ) {
            return;
        }
        /** Checked and claimed with no await between, since both lists can list the PR. */
        const previousRetry = autoStartState.failedPostRetries[pullRequest.url];
        if (
            previousRetry &&
            (previousRetry.count >= maxFailedPostRetries ||
                Date.now() - previousRetry.sentAt <= retryGap.milliseconds)
        ) {
            return;
        }
        autoStartState.failedPostRetries = {
            ...autoStartState.failedPostRetries,
            [pullRequest.url]: {
                count: (previousRetry?.count ?? 0) + 1,
                sentAt: Date.now(),
            },
        };
        await deps.launchFolderSession({
            folder: review.folder,
            prompt: createFolderReviewPrompt({
                command: review.failedVerdict,
                folder: review.folder,
            }),
        });
        log.info(`Retried the failed ${review.failedVerdict} post on ${pullRequest.url}.`);
    } catch (error) {
        log.warning(
            `Failed to retry the failed review post on ${pullRequest.url}: ${extractErrorMessage(error)}`,
        );
    }
}

/** A review in one of these is done, so a new request for the viewer's review starts it over. */
const finishedReviewStatuses: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Approved]: true,
    [ManualReviewStatus.RequestedChanges]: true,
    [ManualReviewStatus.Commented]: true,
    [ManualReviewStatus.Aborted]: false,
    [ManualReviewStatus.PostFailed]: false,
    [ManualReviewStatus.Started]: false,
};

/** Runs the repo's init command once the skill has set the review folder up. */
async function initStartedReview({
    pullRequest,
    deps,
}: Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    try {
        await waitUntil.isTrue(
            async () => {
                const startedReview = await readManualReviewState(pullRequest);
                return (
                    startedReview?.status === ManualReviewStatus.Started && !startedReview.isPending
                );
            },
            {
                interval: {
                    seconds: 5,
                },
                timeout: {
                    hours: 1,
                },
            },
        );
        await deps.runReviewInitCmd(pullRequest);
    } catch (error) {
        log.warning(
            `Failed to run the review init command for ${pullRequest.url}: ${extractErrorMessage(error)}`,
        );
    }
}

/**
 * How long after a verdict is posted the search can still list the viewer's cleared review request.
 * A request seen at startup on a verdict older than this was made after the verdict.
 */
const postedVerdictListingLag: AnyDuration = {
    minutes: 5,
};

async function autoStartReview({
    pullRequest,
    isReRequested,
    isAwaitingAtStartup,
    deps,
}: Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
    isReRequested: boolean;
    /** The viewer's review request was already listed in the list's first update since startup. */
    isAwaitingAtStartup: boolean;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    try {
        if (await isAutoManualReviewDisabled()) {
            return;
        }
        const {folder, review} = await resolveReviewFolder({
            owner: pullRequest.owner,
            repoName: pullRequest.repoName,
            number: pullRequest.number,
            createFolder: false,
        });
        const isRestart =
            !!review &&
            !review.isPending &&
            finishedReviewStatuses[review.status] &&
            (isReRequested ||
                (isAwaitingAtStartup &&
                    Date.now() - review.lastUpdatedAt >
                        convertDuration(postedVerdictListingLag, {
                            milliseconds: true,
                        }).milliseconds));
        /**
         * The skill only records a review once its runner gets going, so a folder with anything in
         * it means a start is underway, or one that failed before recording, such as on GitHub's
         * rate limit, once its AI tab has gone quiet.
         */
        const isFolderEmpty = !(await readdir(folder).catch(() => [])).length;
        const isFailedStart =
            !review &&
            !isFolderEmpty &&
            hasLaunchCooledDown(pullRequest.url) &&
            !busyPaneStatuses[(await readReviewHost().getPaneStatusLookup())(folder, PaneKind.Ai)];
        if (!isRestart && !isFailedStart && (review || !isFolderEmpty)) {
            return;
        }
        await resolveReviewFolder({
            owner: pullRequest.owner,
            repoName: pullRequest.repoName,
            number: pullRequest.number,
            createFolder: true,
        });
        autoStartState.launchedAt = {
            ...autoStartState.launchedAt,
            [pullRequest.url]: Date.now(),
        };
        await deps.launchFolderSession({
            folder,
            prompt: createManualReviewPrompt({
                pullRequest,
                folder,
            }),
        });
        log.info(
            `${isRestart ? 'Restarted' : isFailedStart ? 'Retried' : 'Started'} a manual review of ${pullRequest.url}.`,
        );
        /** The skill can take a long while to set up, and the next PR's start shouldn't wait on it. */
        void initStartedReview({
            pullRequest,
            deps,
        });
    } catch (error) {
        log.warning(
            `Failed to auto-start a manual review of ${pullRequest.url}: ${extractErrorMessage(error)}`,
        );
    }
}

/** Reviews in the Build folder itself, so its first AI tab gets the prompt. */
async function autoStartBuildReview({
    folder,
    branchName,
    prUrl,
    deps,
}: Readonly<{
    folder: string;
    branchName: string;
    prUrl: string;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    try {
        const slug = await readReviewHost().getRepoSlug(folder);
        if (
            (await isAutoManualReviewDisabled()) ||
            !slug ||
            (await readManualReviewState({
                owner: slug.owner,
                repoName: slug.name,
                branchName,
            }))
        ) {
            return;
        }
        await deps.launchFolderSession({
            folder,
            prompt: createManualReviewPrompt({
                pullRequest: {
                    owner: slug.owner,
                    repoName: slug.name,
                    url: prUrl,
                },
                folder,
                isPrCheckedOut: true,
            }),
        });
        log.info(`Started a manual review of ${prUrl} in ${folder}.`);
    } catch (error) {
        log.warning(
            `Failed to auto-start a manual review of ${prUrl}: ${extractErrorMessage(error)}`,
        );
    }
}
