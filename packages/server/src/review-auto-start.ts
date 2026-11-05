import {
    createManualReviewPrompt,
    ManualReviewStatus,
    PrStatus,
    type PullRequestRef,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {waitUntil} from '@augment-vir/assert';
import {awaitedForEach, extractErrorMessage, log, removeDuplicates} from '@augment-vir/common';
import {readdir} from 'node:fs/promises';
import {listenToNewFolderPrs} from './folder-info.js';
import {getRepoSlug} from './git.js';
import {
    listenToAssigneeQueue,
    listenToReviewQueue,
    readAssigneeQueue,
    readReviewQueue,
    resolveReviewFolder,
} from './github-review-queue.js';
import {readManualReviewState} from './manual-review-state.js';

export type ReviewAutoStartDeps = {
    /** Types `prompt` into the folder's first AI tab, starting that tab first if it isn't running. */
    launchFolderSession(params: Readonly<{folder: string; prompt: string}>): Promise<void>;
    /** Runs the repo's review init command in the review folder's shell tab. */
    runReviewInitCmd(pullRequest: Readonly<PullRequestRef>): Promise<void>;
};

/** Statuses of a PR that's no longer open, so has nothing left to review. */
const finishedPrStatuses: Readonly<Record<PrStatus, boolean>> = {
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
} = {
    triedUrls: [],
};

/**
 * Starts a manual review of every PR in the Reviewer or Assignee list without one, so each is ready
 * by the time it's opened, and of every Build folder's branch that just got a PR. A reviewed PR
 * whose review is requested again gets its review restarted. Runs whether or not any frontend is
 * open.
 */
export function startReviewAutoStart(deps: Readonly<ReviewAutoStartDeps>) {
    listenToNewFolderPrs(({path, branch, prUrl, prStatus}) => {
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
    });
    listenToReviewQueue(createQueueListener(deps));
    listenToAssigneeQueue(createQueueListener(deps));
    /**
     * The queues only poll GitHub once something reads them. Polling starts before the read's pane
     * lookup, so a failing lookup can be ignored.
     */
    readReviewQueue().catch(() => undefined);
    readAssigneeQueue().catch(() => undefined);
}

/**
 * Restarts a finished review only when the viewer's review request is new since the list's previous
 * update. Posting a verdict clears the request on GitHub, but the search can keep listing it for an
 * update or two, which would otherwise restart the review that was just posted.
 */
function createQueueListener(deps: Readonly<ReviewAutoStartDeps>) {
    const queueState: {
        /** Undefined until the list's first update, so a server restart restarts nothing. */
        awaitingUrls: ReadonlyArray<string> | undefined;
    } = {
        awaitingUrls: undefined,
    };
    return (pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => {
        const previousAwaitingUrls = queueState.awaitingUrls;
        queueState.awaitingUrls = pullRequests
            .filter((pr) => pr.isAwaitingViewerReview)
            .map((pr) => pr.url);
        const candidates = pullRequests
            /** A PR from outside the repo would put a stranger's code and text in front of the AI. */
            .filter((pr) => pr.isAuthorTrusted && !pr.isViewerAuthor && !pr.isDraft)
            .map((pr) => {
                return {
                    pullRequest: pr,
                    isReRequested:
                        !!previousAwaitingUrls &&
                        pr.isAwaitingViewerReview &&
                        !previousAwaitingUrls.includes(pr.url),
                };
            })
            .filter(({pullRequest, isReRequested}) => {
                return isReRequested || !autoStartState.triedUrls.includes(pullRequest.url);
            });
        autoStartState.triedUrls = removeDuplicates([
            ...autoStartState.triedUrls,
            ...candidates.map(({pullRequest}) => pullRequest.url),
        ]);
        /** Starting an AI takes a while, and the queue's next update shouldn't wait on it. */
        void awaitedForEach(candidates, async ({pullRequest, isReRequested}) => {
            await autoStartReview({
                pullRequest,
                isReRequested,
                deps,
            });
        });
    };
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

async function autoStartReview({
    pullRequest,
    isReRequested,
    deps,
}: Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
    isReRequested: boolean;
    deps: Readonly<ReviewAutoStartDeps>;
}>) {
    try {
        const {folder, review} = await resolveReviewFolder({
            owner: pullRequest.owner,
            repoName: pullRequest.repoName,
            number: pullRequest.number,
            createFolder: false,
        });
        const isRestart =
            isReRequested && !!review && !review.isPending && finishedReviewStatuses[review.status];
        /**
         * The skill only records a review once its runner gets going, so a folder with anything in
         * it means a start is already underway.
         */
        const isFolderEmpty = !(await readdir(folder).catch(() => [])).length;
        if (!isRestart && (review || !isFolderEmpty)) {
            return;
        }
        await resolveReviewFolder({
            owner: pullRequest.owner,
            repoName: pullRequest.repoName,
            number: pullRequest.number,
            createFolder: true,
        });
        await deps.launchFolderSession({
            folder,
            prompt: createManualReviewPrompt({
                pullRequest,
                folder,
            }),
        });
        log.info(`${isRestart ? 'Restarted' : 'Started'} a manual review of ${pullRequest.url}.`);
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
        const slug = await getRepoSlug(folder);
        if (
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
