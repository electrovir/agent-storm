import {
    diffPaneId,
    gitHubPrEndpoint,
    manualReviewCopyEndpoint,
    manualReviewStateEndpoint,
    ManualReviewStatus,
    paneInputEndpoint,
    PaneKind,
    reviewInitEndpoint,
    type ManualReviewState,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {
    fetchApi,
    findShownSessionId,
    type FolderSessionsObservable,
    type UiLayoutObservable,
} from '@agent-storm/core/frontend';
import {extractErrorMessage, pickObjectKeys} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration} from 'date-vir';
import {Observable} from 'element-vir';
import {reviewPrKey, type PrReviewsObservable, type ReviewVerdict} from './pr-reviews.js';

/** A verdict can only be posted while the skill holds a review that hasn't posted yet. */
export const canPostVerdictByStatus: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Started]: true,
    [ManualReviewStatus.Approved]: false,
    [ManualReviewStatus.RequestedChanges]: false,
    [ManualReviewStatus.Commented]: false,
    [ManualReviewStatus.PostFailed]: true,
    [ManualReviewStatus.Aborted]: false,
};

/** The parts of a PR the Review pane reads, which a Build folder's own PR also has. */
export type ReviewPanePr = Pick<
    ReviewQueuePr,
    | 'owner'
    | 'repoName'
    | 'number'
    | 'title'
    | 'titleHtml'
    | 'url'
    | 'bodyHtml'
    | 'branchName'
    | 'author'
    | 'authorAvatarUrl'
>;

/** A manual review to start in a review folder's AI pane once its first session loads. */
export type ReviewStart = {
    prompt: string;
    /**
     * The review's `lastUpdatedAt` (0 for none) when it was requested, which keeps the review
     * buttons locked until the skill records something newer.
     */
    reviewUpdatedAt: number;
    /** Runs the Review tab's init command once the started review's checkout exists. */
    isStart: boolean;
    /**
     * Kept by the review stage rather than the pane group so a remount (a tab switch on mobile)
     * doesn't type the prompt again.
     */
    isSent: boolean;
};

type PaneReviewState = {
    /** The PR the review UI acts on: a review folder's PR, or a Build folder's `buildPr`. */
    pullRequest: ReviewPanePr | undefined;
    /**
     * The PR on a Build folder's branch, which its Review tab and the Diff tab's verdict buttons
     * act on. Only looked up once one of those tabs first shows in this folder, then again when the
     * folder list first sees the branch's PR.
     */
    buildPr: ReviewPanePr | undefined;
    buildPrError: string | undefined;
    isBuildPrMissing: boolean;
    /** The `hasPr` input as of the last `buildPr` lookup, or `undefined` before the first. */
    buildPrLookupHasPr: boolean | undefined;
    /** Whether the Review pane was showing in the active folder as of the last sync. */
    wasReviewPaneOpen: boolean;
    /** Where the manual-review skill says this review stands. Only polled while active. */
    review: ManualReviewState | undefined;
    reviewPollHandle: ReturnType<typeof setInterval> | undefined;
    /**
     * The review's `lastUpdatedAt` (0 for none) when a manual review was started or reset from
     * here. Once the skill records a finished start newer than that, the Diff tab opens.
     */
    diffJumpAfter: number | undefined;
    /** Same as `diffJumpAfter`, for running the Review tab's init command. */
    initCmdAfter: number | undefined;
    /**
     * The review's `lastUpdatedAt` when Approve or Request Changes was clicked, in either the Diff
     * tab or the Review pane. Both stay disabled until the skill records something newer.
     */
    verdictSentAt: number | undefined;
    /**
     * The `/manual-review here` copy of a Build folder's branch, once the skill has made one. Only
     * looked up once the Diff tab first opens.
     */
    reviewCopyFolder: string | undefined;
    reviewCopyPollHandle: ReturnType<typeof setInterval> | undefined;
    /** The last `ReviewStart` typed, for the renders between typing it and it being marked sent. */
    sentReviewStart: Readonly<ReviewStart> | undefined;
    /** Keeps the Diff tab on the manual review while its copy is still being made. */
    isManualReviewStarting: boolean;
};

/** Whether Approve and Request Changes can be clicked. */
export function canPostVerdict({
    review,
    verdictSentAt,
}: Readonly<Pick<PaneReviewState, 'review' | 'verdictSentAt'>>) {
    return (
        !!review &&
        canPostVerdictByStatus[review.status] &&
        !review.isPending &&
        verdictSentAt !== review.lastUpdatedAt
    );
}

export type PaneReviewObservable = ReturnType<typeof createPaneReview>;

/**
 * A pane group's PR and the manual review on it: looks up a Build folder's PR, polls the review and
 * the folder's review copy while the group is active, types review prompts into the AI pane, and
 * acts on review updates.
 */
export function createPaneReview({
    folder,
    uiLayout,
    folderSessions,
    prReviews,
}: Readonly<{
    folder: string;
    /** Holds the tab layout, to find the AI session the user is on and to show tabs. */
    uiLayout: UiLayoutObservable;
    /** Supplies the AI session prompts are typed into, and shows this review's errors. */
    folderSessions: FolderSessionsObservable;
    prReviews: PrReviewsObservable;
}>) {
    const observable = new Observable<PaneReviewState>({
        defaultValue: {
            pullRequest: undefined,
            buildPr: undefined,
            buildPrError: undefined,
            isBuildPrMissing: false,
            buildPrLookupHasPr: undefined,
            wasReviewPaneOpen: false,
            review: undefined,
            reviewPollHandle: undefined,
            diffJumpAfter: undefined,
            initCmdAfter: undefined,
            verdictSentAt: undefined,
            reviewCopyFolder: undefined,
            reviewCopyPollHandle: undefined,
            sentReviewStart: undefined,
            isManualReviewStarting: false,
        },
    });
    const destroyObservable = observable.destroy.bind(observable);

    function update(partial: Partial<PaneReviewState>) {
        observable.setValue({
            ...observable.value,
            ...partial,
        });
    }

    async function loadBuildPr({
        hasPr,
        forceRefresh,
    }: Readonly<{
        hasPr: boolean;
        forceRefresh: boolean;
    }>) {
        try {
            const pr = (
                await fetchApi(gitHubPrEndpoint, HttpMethod.Post, {
                    requestData: {
                        folder,
                        forceRefresh,
                    },
                })
            ).pr;
            if (!pr && !forceRefresh && hasPr) {
                /** The folder list has already found this branch's PR, so a cached miss is stale. */
                await loadBuildPr({
                    hasPr,
                    forceRefresh: true,
                });
                return;
            }
            update({
                buildPr: pr
                    ? {
                          ...pr,
                          branchName: pr.headRefName,
                      }
                    : undefined,
                isBuildPrMissing: !pr,
                buildPrError: undefined,
            });
        } catch (error) {
            update({
                buildPrError: extractErrorMessage(error),
            });
        }
    }

    async function loadReview(pullRequest: Readonly<ReviewPanePr>) {
        try {
            const {review} = await fetchApi(manualReviewStateEndpoint, HttpMethod.Post, {
                requestData: {
                    owner: pullRequest.owner,
                    repoName: pullRequest.repoName,
                    branchName: pullRequest.branchName,
                },
            });
            update({
                review: review ?? undefined,
            });
        } catch {
            /** The next poll tries again. */
        }
    }

    async function loadReviewCopy() {
        try {
            const response = await fetchApi(manualReviewCopyEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                },
            });
            update({
                reviewCopyFolder: response.folder ?? undefined,
            });
        } catch {
            /** The next poll tries again. */
        }
    }

    /** Types `prompt` into the AI pane's selected session. On mobile, switches to the AI pane first. */
    async function sendPrompt({
        prompt,
        isMobile,
    }: Readonly<{
        prompt: string;
        isMobile: boolean;
    }>) {
        const aiSessions = folderSessions.value.sessions?.ai || [];
        const tabLayout = uiLayout.getTabLayout(folder);
        const shownSessionId = tabLayout && findShownSessionId(tabLayout, PaneKind.Ai);
        const session =
            aiSessions.find((aiSession) => aiSession.id === shownSessionId) || aiSessions[0];
        if (!session) {
            folderSessions.reportError(new Error('The AI pane has no session to type into yet.'));
            return;
        }
        if (isMobile) {
            uiLayout.showPaneTab({
                folder,
                kind: PaneKind.Ai,
            });
        }
        try {
            await fetchApi(paneInputEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                    kind: PaneKind.Ai,
                    sessionId: session.id,
                    text: prompt,
                },
            });
        } catch (error) {
            folderSessions.reportError(error);
        }
    }

    /** Whether the review has recorded a finished change newer than `after`. */
    function hasReviewUpdatedSince(after: number | undefined) {
        const {review} = observable.value;
        return after != undefined && !!review && !review.isPending && review.lastUpdatedAt > after;
    }

    return Object.assign(observable, {
        sendPrompt,
        /** Run from each pane group render. */
        sync({
            active,
            hasPr,
            isPrNeeded,
            isReviewPaneOpen,
            isDiffMounted,
            reviewPullRequest,
        }: Readonly<{
            active: boolean;
            hasPr: boolean;
            /** Whether a tab that acts on a Build folder's PR is showing. */
            isPrNeeded: boolean;
            /** Whether the Review pane is showing in the active folder. */
            isReviewPaneOpen: boolean;
            isDiffMounted: boolean;
            reviewPullRequest: Readonly<ReviewQueuePr> | undefined;
        }>) {
            /**
             * Each lookup runs GitHub's full PR query, which costs far more rate limit than the
             * folder list's per-repo PR check, so a missing PR is only looked up again once that
             * check finds one.
             */
            if (
                !reviewPullRequest &&
                isPrNeeded &&
                active &&
                !observable.value.buildPr &&
                observable.value.buildPrLookupHasPr !== hasPr
            ) {
                const isRepeatLookup = observable.value.buildPrLookupHasPr != undefined;
                update({
                    buildPrLookupHasPr: hasPr,
                });
                void loadBuildPr({
                    hasPr,
                    forceRefresh: isRepeatLookup,
                });
            }
            if (isReviewPaneOpen !== observable.value.wasReviewPaneOpen) {
                update({
                    wasReviewPaneOpen: isReviewPaneOpen,
                });
                if (isReviewPaneOpen && !reviewPullRequest && observable.value.isBuildPrMissing) {
                    update({
                        isBuildPrMissing: false,
                    });
                    void loadBuildPr({
                        hasPr,
                        forceRefresh: true,
                    });
                }
                const openedPullRequest = reviewPullRequest || observable.value.buildPr;
                if (isReviewPaneOpen && openedPullRequest) {
                    void refreshStaleReviewPr({
                        pullRequest: openedPullRequest,
                        prReviews,
                    });
                }
            }

            const polledPullRequest = reviewPullRequest || observable.value.buildPr;
            if (polledPullRequest !== observable.value.pullRequest) {
                update({
                    pullRequest: polledPullRequest,
                });
            }
            if (hasReviewUpdatedSince(observable.value.verdictSentAt)) {
                update({
                    verdictSentAt: undefined,
                });
                if (
                    observable.value.review?.status === ManualReviewStatus.PostFailed &&
                    polledPullRequest
                ) {
                    prReviews.clearVerdict(polledPullRequest.url);
                }
            }
            if (hasReviewUpdatedSince(observable.value.diffJumpAfter)) {
                update({
                    diffJumpAfter: undefined,
                });
                /**
                 * A verdict prompt also arrives through `reviewStart`, and someone who has moved on
                 * to another folder or PR stays where they are.
                 */
                if (active && observable.value.review?.status === ManualReviewStatus.Started) {
                    void Promise.resolve().then(() => {
                        uiLayout.showPaneTab({
                            folder,
                            kind: diffPaneId,
                        });
                    });
                }
            }
            if (hasReviewUpdatedSince(observable.value.initCmdAfter)) {
                update({
                    initCmdAfter: undefined,
                });
                if (
                    reviewPullRequest &&
                    observable.value.review?.status === ManualReviewStatus.Started
                ) {
                    void fetchApi(reviewInitEndpoint, HttpMethod.Post, {
                        requestData: pickObjectKeys(reviewPullRequest, [
                            'owner',
                            'repoName',
                            'number',
                        ]),
                    }).catch(folderSessions.reportError);
                }
            }
            if (!active && observable.value.reviewPollHandle) {
                clearInterval(observable.value.reviewPollHandle);
                update({
                    reviewPollHandle: undefined,
                });
            }
            if (polledPullRequest && active && !observable.value.reviewPollHandle) {
                void loadReview(polledPullRequest);
                update({
                    reviewPollHandle: setInterval(
                        () => {
                            void loadReview(polledPullRequest);
                        },
                        convertDuration(
                            {
                                seconds: 2,
                            },
                            {
                                milliseconds: true,
                            },
                        ).milliseconds,
                    ),
                });
            }

            const shouldPollReviewCopy = isDiffMounted && !reviewPullRequest && active;
            if (!shouldPollReviewCopy && observable.value.reviewCopyPollHandle) {
                clearInterval(observable.value.reviewCopyPollHandle);
                update({
                    reviewCopyPollHandle: undefined,
                });
            }
            if (shouldPollReviewCopy && !observable.value.reviewCopyPollHandle) {
                void loadReviewCopy();
                update({
                    reviewCopyPollHandle: setInterval(
                        () => {
                            void loadReviewCopy();
                        },
                        convertDuration(
                            {
                                seconds: 5,
                            },
                            {
                                milliseconds: true,
                            },
                        ).milliseconds,
                    ),
                });
            }
        },
        /** What both the Diff tab's and the Review pane's Approve and Request Changes run. */
        async requestVerdict({
            verdict,
            isMobile,
        }: Readonly<{
            verdict: ReviewVerdict;
            isMobile: boolean;
        }>) {
            const {review, pullRequest} = observable.value;
            if (!review || !canPostVerdict(observable.value) || !pullRequest) {
                return;
            }
            update({
                verdictSentAt: review.lastUpdatedAt,
            });
            await prReviews.requestVerdict({
                pullRequest,
                verdict,
                sendPrompt(prompt) {
                    return sendPrompt({
                        prompt,
                        isMobile,
                    });
                },
            });
        },
        setManualReviewStarting(isManualReviewStarting: boolean) {
            update({
                isManualReviewStarting,
            });
        },
        /** Opens the Diff tab once the manual review just started from the Review pane is ready. */
        markManualReviewStarted() {
            update({
                diffJumpAfter: observable.value.review?.lastUpdatedAt ?? 0,
            });
        },
        /**
         * Types `reviewStart`'s prompt once the AI pane's sessions have loaded, then opens the Diff
         * tab, and for a fresh start runs the init command, once the review records something
         * newer. Returns whether this call typed it, which is when the caller should mark it sent.
         */
        sendReviewStart({
            reviewStart,
            isMobile,
        }: Readonly<{
            reviewStart: Readonly<ReviewStart>;
            isMobile: boolean;
        }>) {
            if (
                reviewStart.isSent ||
                !folderSessions.value.sessions ||
                observable.value.sentReviewStart === reviewStart
            ) {
                return false;
            }
            update({
                sentReviewStart: reviewStart,
                diffJumpAfter: reviewStart.reviewUpdatedAt,
                initCmdAfter: reviewStart.isStart ? reviewStart.reviewUpdatedAt : undefined,
            });
            void sendPrompt({
                prompt: reviewStart.prompt,
                isMobile,
            });
            return true;
        },
        destroy() {
            clearInterval(observable.value.reviewPollHandle);
            clearInterval(observable.value.reviewCopyPollHandle);
            destroyObservable();
        },
    });
}

async function refreshStaleReviewPr({
    pullRequest,
    prReviews,
}: Readonly<{
    pullRequest: Readonly<ReviewPanePr>;
    prReviews: PrReviewsObservable;
}>) {
    const request = {
        owner: pullRequest.owner,
        repoName: pullRequest.repoName,
        branchName: pullRequest.branchName,
        number: pullRequest.number,
    };
    function findLoadedDetails() {
        const loaded = prReviews.value.reviewPrs[reviewPrKey(pullRequest)];
        return loaded?.number === pullRequest.number ? loaded.details : undefined;
    }
    /** A first load answers from the server's cache, which can be just as old. */
    if (!findLoadedDetails()) {
        await prReviews.loadReviewPr({
            ...request,
            forceRefresh: false,
        });
    }
    const fetchedAt = findLoadedDetails()?.fetchedAt;
    if (
        fetchedAt != undefined &&
        Date.now() - fetchedAt >
            convertDuration(
                {
                    minutes: 5,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds
    ) {
        await prReviews.loadReviewPr({
            ...request,
            forceRefresh: true,
        });
    }
}
