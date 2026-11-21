import {
    aiChatPaneId,
    diffPaneId,
    ManualReviewStatus,
    ThreadOrigin,
    type ManualReviewState,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {
    addTab,
    type FolderDataObservable,
    type FolderSessionsObservable,
    type UiLayoutObservable,
} from '@agent-storm/core/frontend';
import {extractErrorMessage, mapObjectValues, pickObjectKeys, wait} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {Observable} from 'element-vir';
import {reviewPrKey, type PrReviewsObservable, type ReviewVerdict} from './pr-reviews.js';
import {reviewClient} from './review-client.js';

/** A thread tab's name, shown instead of the AI Chat pane's label. */
const threadTabNames: Readonly<Record<ThreadOrigin, string>> = {
    [ThreadOrigin.User]: 'AI Chat',
    [ThreadOrigin.Review]: 'AI Review',
    [ThreadOrigin.Watch]: 'AI Watch',
    [ThreadOrigin.SideChat]: 'AI Chat',
};

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

/** A manual review to start in a review folder's review thread. */
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
     * act on. Only looked up once one of those tabs first shows in this folder, then again whenever
     * the folder list's PR for the branch changes, such as a new PR replacing a closed one.
     */
    buildPr: ReviewPanePr | undefined;
    buildPrError: string | undefined;
    isBuildPrMissing: boolean;
    /** The `prUrl` input as of the last `buildPr` lookup, or `undefined` before the first. */
    buildPrLookup:
        | {
              prUrl: string | undefined;
          }
        | undefined;
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
    /** Looks for the folder's review and watch mode threads while the group is active. */
    threadPollHandle: ReturnType<typeof setInterval> | undefined;
    /**
     * The thread tabs this page has added, so a tab the user closes stays closed until the page
     * reloads.
     */
    addedThreadTabIds: ReadonlyArray<string>;
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
 * the folder's review copy while the group is active, sends review prompts to the review thread,
 * and acts on review updates.
 */
export function createPaneReview({
    folder,
    uiLayout,
    folderSessions,
    prReviews,
    folderData,
}: Readonly<{
    folder: string;
    /** Fetched again once a verdict's status is held, so the rings show it at once. */
    folderData: Pick<FolderDataObservable, 'refresh'>;
    /** Holds the tab layout, to show tabs. */
    uiLayout: UiLayoutObservable;
    /** Shows this review's errors. */
    folderSessions: FolderSessionsObservable;
    prReviews: PrReviewsObservable;
}>) {
    const observable = new Observable<PaneReviewState>({
        defaultValue: {
            pullRequest: undefined,
            buildPr: undefined,
            buildPrError: undefined,
            isBuildPrMissing: false,
            buildPrLookup: undefined,
            wasReviewPaneOpen: false,
            review: undefined,
            reviewPollHandle: undefined,
            diffJumpAfter: undefined,
            initCmdAfter: undefined,
            verdictSentAt: undefined,
            reviewCopyFolder: undefined,
            reviewCopyPollHandle: undefined,
            threadPollHandle: undefined,
            addedThreadTabIds: [],
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
        prUrl,
        forceRefresh,
    }: Readonly<{
        prUrl: string | undefined;
        forceRefresh: boolean;
    }>) {
        try {
            const pr = (
                await reviewClient.call('readFolderPr', {
                    folder,
                    forceRefresh,
                })
            ).pr;
            if (!forceRefresh && prUrl && pr?.url !== prUrl) {
                /** The folder list has already found a different PR, so the cached answer is stale. */
                await loadBuildPr({
                    prUrl,
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
            const failedLookup = observable.value.buildPrLookup;
            update({
                buildPrError: extractErrorMessage(error),
            });
            /**
             * Otherwise only a different PR in the folder list looks it up again, so a failure such
             * as a server restart would leave the Diff tab's manual review unreachable for good.
             */
            await wait({
                seconds: 10,
            });
            if (observable.value.buildPrLookup === failedLookup) {
                update({
                    buildPrLookup: undefined,
                });
            }
        }
    }

    async function loadReview(pullRequest: Readonly<ReviewPanePr>) {
        try {
            const {review} = await reviewClient.call('readManualReviewState', {
                owner: pullRequest.owner,
                repoName: pullRequest.repoName,
                branchName: pullRequest.branchName,
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
            const response = await reviewClient.call('findManualReviewCopy', {
                folder,
            });
            update({
                reviewCopyFolder: response.folder ?? undefined,
            });
        } catch {
            /** The next poll tries again. */
        }
    }

    /** Adds a tab showing a review or watch mode thread, in the background unless `isShown`. */
    function addThreadTab({
        threadId,
        origin,
        isShown,
    }: Readonly<{
        threadId: string;
        origin: ThreadOrigin;
        isShown: boolean;
    }>) {
        const tabId = `${aiChatPaneId}:${threadId}`;
        if (!observable.value.addedThreadTabIds.includes(tabId)) {
            update({
                addedThreadTabIds: [
                    ...observable.value.addedThreadTabIds,
                    tabId,
                ],
            });
        }
        uiLayout.updateTabLayout({
            folder,
            update(current) {
                if (!current || (!isShown && current.tabs[tabId])) {
                    return current;
                }
                const added = addTab(current, {
                    tab: {
                        id: tabId,
                        kind: aiChatPaneId,
                        name: threadTabNames[origin],
                        state: {
                            threadId,
                        },
                    },
                });
                return isShown
                    ? added
                    : {
                          ...added,
                          groups: mapObjectValues(added.groups, (groupId, group) => {
                              return {
                                  ...group,
                                  activeTabId:
                                      current.groups[groupId]?.activeTabId || group.activeTabId,
                              };
                          }),
                          activeGroupId: current.activeGroupId,
                      };
            },
        });
    }

    async function loadReviewThreads() {
        try {
            const {threads} = await reviewClient.call('readReviewThreads', {
                folder,
            });
            threads
                .filter((thread) => {
                    return !observable.value.addedThreadTabIds.includes(
                        `${aiChatPaneId}:${thread.threadId}`,
                    );
                })
                .forEach((thread) => {
                    addThreadTab({
                        ...thread,
                        isShown: false,
                    });
                });
        } catch {
            /** The next poll tries again. */
        }
    }

    /**
     * Sends `prompt` to the folder's review thread, which the server starts when there's none, and
     * adds the thread's tab. On mobile, shows that tab. Failures are reported, and resolve to
     * `false`.
     */
    async function sendPrompt({
        prompt,
        isMobile,
    }: Readonly<{
        prompt: string;
        isMobile: boolean;
    }>) {
        try {
            const {threadId} = await reviewClient.call('sendToReviewThread', {
                folder,
                prompt,
                prUrl: observable.value.pullRequest?.url || '',
            });
            addThreadTab({
                threadId,
                origin: ThreadOrigin.Review,
                isShown: isMobile,
            });
            return true;
        } catch (error) {
            folderSessions.reportError(error);
            return false;
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
            prUrl,
            isPrNeeded,
            isReviewPaneOpen,
            isDiffMounted,
            reviewPullRequest,
        }: Readonly<{
            active: boolean;
            prUrl: string | undefined;
            /** Whether a tab that acts on a Build folder's PR is showing. */
            isPrNeeded: boolean;
            /** Whether the Review pane is showing in the active folder. */
            isReviewPaneOpen: boolean;
            isDiffMounted: boolean;
            reviewPullRequest: Readonly<ReviewQueuePr> | undefined;
        }>) {
            /**
             * Each lookup runs GitHub's full PR query, which costs far more rate limit than the
             * folder list's per-repo PR check, so the PR is only looked up again once that check
             * finds a different one.
             */
            const isBuildPrOutdated = observable.value.buildPrLookup
                ? observable.value.buildPrLookup.prUrl !== prUrl &&
                  observable.value.buildPr?.url !== prUrl
                : !observable.value.buildPr;
            if (!reviewPullRequest && isPrNeeded && active && isBuildPrOutdated) {
                const isRepeatLookup = !!observable.value.buildPrLookup;
                update({
                    buildPrLookup: {
                        prUrl,
                    },
                });
                void loadBuildPr({
                    prUrl,
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
                        prUrl,
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
                    void reviewClient
                        .call(
                            'runReviewInit',
                            pickObjectKeys(reviewPullRequest, [
                                'owner',
                                'repoName',
                                'number',
                            ]),
                        )
                        .catch(folderSessions.reportError);
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

            if (!active && observable.value.threadPollHandle) {
                clearInterval(observable.value.threadPollHandle);
                update({
                    threadPollHandle: undefined,
                });
            }
            if (active && !observable.value.threadPollHandle) {
                void loadReviewThreads();
                update({
                    threadPollHandle: setInterval(
                        () => {
                            void loadReviewThreads();
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
            const isSent = await prReviews.requestVerdict({
                pullRequest,
                verdict,
                refreshFolders: folderData.refresh,
                sendPrompt(prompt) {
                    return sendPrompt({
                        prompt,
                        isMobile,
                    });
                },
            });
            if (!isSent) {
                update({
                    verdictSentAt: undefined,
                });
            }
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
         * Sends `reviewStart`'s prompt, then opens the Diff tab, and for a fresh start runs the
         * init command, once the review records something newer. Returns whether this call sent it,
         * which is when the caller should mark it sent.
         */
        sendReviewStart({
            reviewStart,
            isMobile,
        }: Readonly<{
            reviewStart: Readonly<ReviewStart>;
            isMobile: boolean;
        }>) {
            if (reviewStart.isSent || observable.value.sentReviewStart === reviewStart) {
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
            clearInterval(observable.value.threadPollHandle);
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
