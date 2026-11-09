import {
    PaneKind,
    PaneStatus,
    PrStatus,
    type ReviewQueue,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {getReviewablePrs, getShownPrQueues, PrQueueKind, type PrQueues} from './pr-queues.js';
import {ReviewVerdict, type PrReviews} from './pr-reviews.js';

function createPr(overrides: Partial<ReviewQueuePr>): ReviewQueuePr {
    return {
        owner: 'acme',
        repoName: 'widgets',
        number: 1,
        title: 'A change',
        titleHtml: 'A change',
        url: 'https://example.com/acme/widgets/pull/1',
        bodyHtml: '',
        branchName: 'feature',
        headSha: 'abc123',
        isDraft: false,
        chainDepth: 0,
        prStatus: PrStatus.None,
        isViewerAuthor: false,
        isAwaitingViewerReview: true,
        hasViewerReviewed: false,
        panes: {
            [PaneKind.Ai]: PaneStatus.None,
            [PaneKind.Shell]: PaneStatus.None,
        },
        author: 'someone',
        authorAvatarUrl: '',
        isAuthorTrusted: true,
        assignees: [],
        ...overrides,
    };
}

function createQueue(overrides: Partial<ReviewQueue>): ReviewQueue {
    return {
        pullRequests: [],
        reviewedPullRequests: undefined,
        updatedAt: 0,
        isUpdating: false,
        error: '',
        ...overrides,
    };
}

function createPrQueues({
    review,
    assignee,
}: Readonly<{
    review: ReviewQueue | undefined;
    assignee: ReviewQueue | undefined;
}>): PrQueues {
    return {
        [PrQueueKind.Review]: {
            queue: review,
            cachedQueue: undefined,
            loadError: undefined,
        },
        [PrQueueKind.Assignee]: {
            queue: assignee,
            cachedQueue: undefined,
            loadError: undefined,
        },
    };
}

describe(getShownPrQueues.name, () => {
    it('moves a verdict-sent Reviewer PR to the reviewed list and overlays the status', () => {
        const sentPr = createPr({
            number: 1,
            url: 'https://example.com/acme/widgets/pull/1',
        });
        const waitingPr = createPr({
            number: 2,
            url: 'https://example.com/acme/widgets/pull/2',
        });
        const alreadyReviewedPr = createPr({
            number: 3,
            url: 'https://example.com/acme/widgets/pull/3',
        });
        const assigneePr = createPr({
            number: 4,
            url: 'https://example.com/acme/widgets/pull/4',
        });
        const prReviews: PrReviews = {
            reviewPrs: {},
            verdicts: {
                [sentPr.url]: {
                    verdict: ReviewVerdict.Approve,
                    prStatus: PrStatus.Approved,
                    requestedAt: Date.now(),
                },
                [assigneePr.url]: {
                    verdict: ReviewVerdict.RequestChanges,
                    prStatus: PrStatus.ChangesRequested,
                    requestedAt: Date.now(),
                },
            },
        };

        const shown = getShownPrQueues({
            prQueues: createPrQueues({
                review: createQueue({
                    pullRequests: [
                        sentPr,
                        waitingPr,
                    ],
                    reviewedPullRequests: [alreadyReviewedPr],
                }),
                assignee: createQueue({
                    pullRequests: [assigneePr],
                }),
            }),
            prReviews,
        });

        assert.deepEquals(
            {
                waiting: shown[PrQueueKind.Review].queue?.pullRequests.map((pr) => pr.number),
                reviewed: shown[PrQueueKind.Review].queue?.reviewedPullRequests?.map((pr) => {
                    return pr.number;
                }),
                assignee: shown[PrQueueKind.Assignee].queue?.pullRequests.map((pr) => {
                    return {
                        number: pr.number,
                        prStatus: pr.prStatus,
                    };
                }),
                assigneeReviewed: shown[PrQueueKind.Assignee].queue?.reviewedPullRequests,
            },
            {
                waiting: [2],
                reviewed: [
                    1,
                    3,
                ],
                assignee: [
                    {
                        number: 4,
                        prStatus: PrStatus.ChangesRequested,
                    },
                ],
                assigneeReviewed: undefined,
            },
        );
    });
});

describe(getReviewablePrs.name, () => {
    it('leaves out the viewer-authored Assignee PRs', () => {
        assert.deepEquals(
            getReviewablePrs(
                createPrQueues({
                    review: createQueue({
                        pullRequests: [
                            createPr({
                                number: 1,
                                isViewerAuthor: true,
                            }),
                        ],
                    }),
                    assignee: createQueue({
                        pullRequests: [
                            createPr({
                                number: 2,
                                isViewerAuthor: true,
                            }),
                            createPr({
                                number: 3,
                            }),
                        ],
                    }),
                }),
            )?.map((pr) => pr.number),
            [
                1,
                3,
            ],
        );
    });
    it('is undefined until the Review queue answers', () => {
        assert.isUndefined(
            getReviewablePrs(
                createPrQueues({
                    review: undefined,
                    assignee: createQueue({}),
                }),
            ),
        );
    });
});
