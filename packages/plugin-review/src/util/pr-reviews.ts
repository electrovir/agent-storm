import {
    closeEditorWindowEndpoint,
    gitHubReviewPrEndpoint,
    GitHubReviewState,
    PrStatus,
    type FolderInfo,
    type ReviewPr,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {fetchApi, reportClientError} from '@agent-storm/core/frontend';
import {extractErrorMessage, omitObjectKeys, typedObjectFromEntries} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, type AnyDuration} from 'date-vir';
import {Observable} from 'element-vir';

export enum ReviewVerdict {
    Approve = 'approve',
    RequestChanges = 'request-changes',
}

export const reviewVerdicts: Record<
    ReviewVerdict,
    {
        /** Typed into the AI pane, where the manual-review skill posts the review. */
        prompt: string;
        /** What the PR's rings show as soon as the verdict is sent. */
        prStatus: PrStatus;
        /** The viewer's review the Review pane shows until GitHub returns the posted one. */
        reviewState: GitHubReviewState;
    }
> = {
    [ReviewVerdict.Approve]: {
        prompt: '/manual-review approve',
        prStatus: PrStatus.Approved,
        reviewState: GitHubReviewState.Approved,
    },
    [ReviewVerdict.RequestChanges]: {
        prompt: '/manual-review request-changes',
        prStatus: PrStatus.ChangesRequested,
        reviewState: GitHubReviewState.ChangesRequested,
    },
};

/** How long a sent verdict's status is shown in place of GitHub's, which lags behind it. */
const verdictOverrideDuration: AnyDuration = {
    minutes: 2,
};

export type ReviewedRepo = Pick<ReviewQueuePr, 'owner' | 'repoName'>;

export function toRepoKey({owner, repoName}: Readonly<ReviewedRepo>) {
    return `${owner}/${repoName}`;
}

type ReviewedBranch = Pick<ReviewQueuePr, 'owner' | 'repoName' | 'branchName'>;

/**
 * Keys {@link PrReviews.reviewPrs} by branch, so a Build folder and its PR's review share one entry.
 * Not interchangeable with a PR's route key, which keys by PR number.
 */
export function reviewPrKey({owner, repoName, branchName}: Readonly<ReviewedBranch>) {
    return `${toRepoKey({
        owner,
        repoName,
    })}>${branchName}`;
}

export type PrReviews = {
    /**
     * The Review pane's PR details, by {@link reviewPrKey}, so the Build and Review tabs show the
     * same copy of a branch's PR.
     */
    reviewPrs: Readonly<
        Record<
            string,
            | Readonly<{
                  number: number;
                  /** Undefined until the first fetch of this PR lands. */
                  details: ReviewPr | undefined;
                  isRefreshing: boolean;
                  loadError: string;
              }>
            | undefined
        >
    >;
    /** Approvals and change requests sent from either tab, by PR url. */
    verdicts: Readonly<
        Record<
            string,
            | Readonly<{
                  verdict: ReviewVerdict;
                  prStatus: PrStatus;
                  requestedAt: number;
              }>
            | undefined
        >
    >;
};

export type PrReviewsObservable = ReturnType<typeof createPrReviews>;

/** Whether a verdict was sent for the PR at `url` less than `within` ago. */
export function hasRecentVerdict({
    prReviews,
    url,
    within,
}: Readonly<{
    prReviews: Readonly<PrReviews>;
    url: string;
    within: AnyDuration;
}>) {
    const verdict = prReviews.verdicts[url];
    return (
        !!verdict &&
        Date.now() - verdict.requestedAt <
            convertDuration(within, {
                milliseconds: true,
            }).milliseconds
    );
}

/**
 * The status a verdict sent for the PR at `url` will leave it in, while GitHub may not show it yet.
 * Undefined otherwise, including while the PR's polled `prStatus` shows unresolved comments, which
 * outrank an approval.
 */
export function getVerdictPrStatus({
    prReviews,
    url,
    prStatus,
}: Readonly<{
    prReviews: Readonly<PrReviews>;
    url: string;
    prStatus: PrStatus;
}>) {
    const verdict = prReviews.verdicts[url];
    return verdict &&
        (prStatus !== PrStatus.UnresolvedComments ||
            verdict.prStatus === PrStatus.ChangesRequested) &&
        hasRecentVerdict({
            prReviews,
            url,
            within: verdictOverrideDuration,
        })
        ? verdict.prStatus
        : undefined;
}

/**
 * {@link getVerdictPrStatus} for each folder whose branch has a PR, by folder path. Folders without
 * a just-sent verdict are left out.
 */
export function getFolderVerdictStatuses({
    prReviews,
    folderInfo,
}: Readonly<{
    prReviews: Readonly<PrReviews>;
    folderInfo: ReadonlyMap<string, Readonly<FolderInfo>>;
}>) {
    return typedObjectFromEntries(
        [...folderInfo].flatMap(
            ([
                folderPath,
                info,
            ]) => {
                const prStatus =
                    info.prUrl &&
                    getVerdictPrStatus({
                        prReviews,
                        url: info.prUrl,
                        prStatus: info.prStatus,
                    });
                return prStatus
                    ? [
                          [
                              folderPath,
                              prStatus,
                          ] as const,
                      ]
                    : [];
            },
        ),
    );
}

/** PR details and sent verdicts, shared by every tab that reviews a PR. */
export function createPrReviews() {
    const observable = new Observable<PrReviews>({
        defaultValue: {
            reviewPrs: {},
            verdicts: {},
        },
    });

    function update(updateValue: Partial<PrReviews>) {
        observable.setValue({
            ...observable.value,
            ...updateValue,
        });
    }

    function updateReviewPr({
        key,
        ...reviewPr
    }: Readonly<
        NonNullable<PrReviews['reviewPrs'][string]> & {
            key: string;
        }
    >) {
        update({
            reviewPrs: {
                ...observable.value.reviewPrs,
                [key]: reviewPr,
            },
        });
    }

    /**
     * The latest `loadReviewPr` call per {@link reviewPrKey}, so an earlier call that answers late
     * doesn't overwrite a newer one's result.
     */
    const latestReviewPrRequests = new Map<string, number>();

    async function recordVerdict({
        pullRequest,
        verdict,
    }: Readonly<{
        pullRequest: Readonly<ReviewedBranch & Pick<ReviewQueuePr, 'url'>>;
        verdict: ReviewVerdict;
    }>) {
        update({
            verdicts: {
                ...observable.value.verdicts,
                [pullRequest.url]: {
                    verdict,
                    prStatus: reviewVerdicts[verdict].prStatus,
                    requestedAt: Date.now(),
                },
            },
        });
        try {
            await fetchApi(closeEditorWindowEndpoint, HttpMethod.Post, {
                requestData: {
                    owner: pullRequest.owner,
                    repoName: pullRequest.repoName,
                    branchName: pullRequest.branchName,
                },
            });
        } catch (error) {
            reportClientError({
                error,
                source: 'closeEditorWindow',
            });
        }
    }

    return Object.assign(observable, {
        async loadReviewPr({
            number,
            forceRefresh,
            ...branch
        }: Readonly<
            ReviewedBranch & {
                number: number;
                forceRefresh: boolean;
            }
        >) {
            const key = reviewPrKey(branch);
            const requestId = (latestReviewPrRequests.get(key) ?? 0) + 1;
            latestReviewPrRequests.set(key, requestId);
            const previous = observable.value.reviewPrs[key];
            const details = previous?.number === number ? previous.details : undefined;
            updateReviewPr({
                key,
                number,
                details,
                isRefreshing: true,
                loadError: '',
            });
            try {
                const fetchedDetails = await fetchApi(gitHubReviewPrEndpoint, HttpMethod.Post, {
                    requestData: {
                        ...branch,
                        number,
                        forceRefresh,
                    },
                });
                if (latestReviewPrRequests.get(key) !== requestId) {
                    return;
                }
                updateReviewPr({
                    key,
                    number,
                    details: fetchedDetails,
                    isRefreshing: false,
                    loadError: '',
                });
            } catch (error) {
                if (latestReviewPrRequests.get(key) !== requestId) {
                    return;
                }
                updateReviewPr({
                    key,
                    number,
                    details,
                    isRefreshing: false,
                    loadError: extractErrorMessage(error),
                });
            }
        },
        /**
         * Hands the verdict's prompt to `sendPrompt`, which types it into the PR's AI pane for the
         * manual-review skill to post. Meanwhile shows the verdict's status everywhere the PR is
         * listed, and closes the editor window the review was read in, without waiting for the
         * skill.
         */
        async requestVerdict({
            sendPrompt,
            ...verdictRequest
        }: Readonly<
            Parameters<typeof recordVerdict>[0] & {
                sendPrompt: (prompt: string) => Promise<void>;
            }
        >) {
            await Promise.all([
                recordVerdict(verdictRequest),
                sendPrompt(reviewVerdicts[verdictRequest.verdict].prompt),
            ]);
        },
        /** For a verdict the skill failed to post. */
        clearVerdict(url: string) {
            update({
                verdicts: omitObjectKeys(observable.value.verdicts, [
                    url,
                ]),
            });
        },
    });
}
