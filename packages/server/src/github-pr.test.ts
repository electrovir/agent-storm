// cspell:word unresolve
import {
    GitHubCheckState,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {checkValidShape} from 'object-shape-tester';
import {rawPrShape, toPr} from './github-pr.js';
import {
    RawCheckContextType,
    RawCheckResult,
    RawCheckStatus,
    RawPrState,
} from './github-raw-enums.js';

/** Minimal PR node; each test overrides only the fields it exercises. */
const baseRawPr: typeof rawPrShape.runtimeType = {
    ...rawPrShape.default,
    id: 'PR_1',
    number: 7,
    url: 'https://github.com/owner/name/pull/7',
    title: 'Add a thing',
    state: RawPrState.Open,
    baseRefName: 'dev',
    headRefName: 'feature',
    author: {
        login: 'electrovir',
        avatarUrl: 'https://avatars.example/electrovir',
    },
};

const baseRawComment = {
    id: 'IC_1',
    body: '',
    bodyHTML: '',
    createdAt: '2026-08-01T00:00:00Z',
    url: 'https://github.com/owner/name/pull/7#issuecomment-1',
    author: {
        login: 'reviewer',
        avatarUrl: '',
    },
};

const baseRawCheckRun = {
    __typename: RawCheckContextType.CheckRun,
    name: '',
    status: RawCheckStatus.Completed,
    checkSuite: {
        workflowRun: null,
    },
} as const;

function createRollup(
    rollup: NonNullable<
        (typeof rawPrShape.runtimeType)['commits']['nodes'][number]['commit']['statusCheckRollup']
    >,
) {
    return {
        nodes: [
            {
                commit: {
                    statusCheckRollup: rollup,
                },
            },
        ],
    };
}

describe(toPr.name, () => {
    it('reads a draft as its own state rather than open', () => {
        assert.strictEquals(
            toPr({
                ...baseRawPr,
                isDraft: true,
            }).state,
            GitHubPrState.Draft,
        );
    });

    it('maps every rollup failure variant onto one failure state', () => {
        const states = [
            RawCheckResult.Failure,
            RawCheckResult.Error,
        ].map((state) => {
            return toPr({
                ...baseRawPr,
                commits: createRollup({
                    state,
                    contexts: {
                        nodes: [],
                    },
                }),
            }).checks;
        });
        assert.deepEquals(states, [
            GitHubCheckState.Failure,
            GitHubCheckState.Failure,
        ]);
    });

    it('reports no checks when the head commit has no rollup', () => {
        assert.strictEquals(toPr(baseRawPr).checks, GitHubCheckState.None);
    });

    it('drops reactions nobody used and keeps the viewer flag on the rest', () => {
        const pr = toPr({
            ...baseRawPr,
            comments: {
                nodes: [
                    {
                        ...baseRawComment,
                        body: 'looks good',
                        reactionGroups: [
                            {
                                content: 'THUMBS_UP',
                                viewerHasReacted: true,
                                reactors: {
                                    totalCount: 2,
                                    nodes: [
                                        {
                                            login: 'reviewer',
                                        },
                                        {
                                            login: 'author',
                                        },
                                    ],
                                },
                            },
                            {
                                content: 'CONFUSED',
                                viewerHasReacted: false,
                                reactors: {
                                    totalCount: 0,
                                    nodes: [],
                                },
                            },
                        ],
                    },
                ],
            },
        });
        assert.deepEquals(pr.comments[0]?.reactions, [
            {
                reaction: GitHubReaction.ThumbsUp,
                count: 2,
                viewerHasReacted: true,
                reactors: [
                    'reviewer',
                    'author',
                ],
            },
        ]);
    });

    it('names a deleted comment author ghost', () => {
        const pr = toPr({
            ...baseRawPr,
            comments: {
                nodes: [
                    {
                        ...baseRawComment,
                        author: null,
                    },
                ],
            },
        });
        assert.strictEquals(pr.comments[0]?.author, 'ghost');
    });

    it('takes the diff hunk from a thread first comment and folds unresolve permission in', () => {
        const pr = toPr({
            ...baseRawPr,
            reviewThreads: {
                nodes: [
                    {
                        id: 'RT_1',
                        path: 'packages/server/src/index.ts',
                        line: 42,
                        isResolved: true,
                        isOutdated: false,
                        viewerCanResolve: false,
                        viewerCanUnresolve: true,
                        comments: {
                            nodes: [
                                {
                                    ...baseRawComment,
                                    id: 'RC_1',
                                    diffHunk: '@@ -1 +1 @@',
                                },
                                {
                                    ...baseRawComment,
                                    id: 'RC_2',
                                    diffHunk: '@@ -9 +9 @@',
                                },
                            ],
                        },
                    },
                ],
            },
        });
        assert.isDefined(pr.threads[0]);
        assert.deepEquals(
            selectFrom(pr.threads[0], {
                id: true,
                path: true,
                line: true,
                isResolved: true,
                viewerCanResolve: true,
                diffHunk: true,
            }),
            {
                id: 'RT_1',
                path: 'packages/server/src/index.ts',
                line: 42,
                isResolved: true,
                viewerCanResolve: true,
                diffHunk: '@@ -1 +1 @@',
            },
        );
    });

    it('reads a still-running check run as pending, since its conclusion is null', () => {
        const pr = toPr({
            ...baseRawPr,
            commits: createRollup({
                state: RawCheckResult.Pending,
                contexts: {
                    nodes: [
                        {
                            __typename: RawCheckContextType.CheckRun,
                            name: 'build (ubuntu-latest)',
                            conclusion: null,
                            status: RawCheckStatus.InProgress,
                            detailsUrl: 'https://github.com/owner/name/runs/1',
                            checkSuite: {
                                workflowRun: {
                                    workflow: {
                                        name: 'Tests',
                                    },
                                },
                            },
                        },
                    ],
                },
            }),
        });
        assert.deepEquals(pr.checkRuns, [
            {
                name: 'build (ubuntu-latest)',
                workflow: 'Tests',
                state: GitHubCheckState.Pending,
                url: 'https://github.com/owner/name/runs/1',
                description: '',
            },
        ]);
    });

    it('counts timed out and cancelled runs as failed but not skipped ones', () => {
        const pr = toPr({
            ...baseRawPr,
            commits: createRollup({
                state: RawCheckResult.Failure,
                contexts: {
                    nodes: [
                        {
                            ...baseRawCheckRun,
                            name: 'lint',
                            conclusion: RawCheckResult.TimedOut,
                        },
                        {
                            ...baseRawCheckRun,
                            name: 'e2e',
                            conclusion: RawCheckResult.Cancelled,
                        },
                        {
                            ...baseRawCheckRun,
                            name: 'docs',
                            conclusion: RawCheckResult.Skipped,
                        },
                        {
                            __typename: RawCheckContextType.StatusContext,
                            context: 'ci/external',
                            state: RawCheckResult.Success,
                            targetUrl: 'https://ci.example/1',
                            description: 'all good',
                        },
                    ],
                },
            }),
        });
        assert.deepEquals(
            pr.checkRuns.map((checkRun) => {
                return selectFrom(checkRun, {
                    name: true,
                    state: true,
                });
            }),
            [
                {
                    name: 'lint',
                    state: GitHubCheckState.Failure,
                },
                {
                    name: 'e2e',
                    state: GitHubCheckState.Failure,
                },
                {
                    name: 'docs',
                    state: GitHubCheckState.None,
                },
                {
                    name: 'ci/external',
                    state: GitHubCheckState.Success,
                },
            ],
        );
    });

    it('names a requested team by its name and drops a reviewer it cannot see', () => {
        const pr = toPr({
            ...baseRawPr,
            reviewRequests: {
                nodes: [
                    {
                        requestedReviewer: {
                            login: 'electrovir',
                            avatarUrl: 'https://avatars.example/electrovir',
                        },
                    },
                    {
                        requestedReviewer: {
                            name: 'platform',
                        },
                    },
                    {
                        requestedReviewer: null,
                    },
                ],
            },
        });
        assert.deepEquals(pr.reviewRequests, [
            {
                reviewer: 'electrovir',
                reviewerAvatarUrl: 'https://avatars.example/electrovir',
            },
            {
                reviewer: 'platform',
                reviewerAvatarUrl: '',
            },
        ]);
    });

    it('falls back to a plain comment for a review state it does not know', () => {
        const pr = toPr({
            ...baseRawPr,
            latestReviews: {
                nodes: [
                    {
                        ...baseRawComment,
                        id: 'PRR_1',
                        state: 'SOMETHING_NEW',
                    },
                ],
            },
        });
        assert.strictEquals(pr.reviews[0]?.state, GitHubReviewState.Commented);
    });
});

describe('rawPrShape', () => {
    it('rejects an answer whose PR state or check type it does not know', () => {
        assert.deepEquals(
            [
                {
                    ...baseRawPr,
                    state: 'SOMETHING_NEW',
                },
                {
                    ...baseRawPr,
                    commits: {
                        nodes: [
                            {
                                commit: {
                                    statusCheckRollup: {
                                        state: RawCheckResult.Success,
                                        contexts: {
                                            nodes: [
                                                {
                                                    ...baseRawCheckRun,
                                                    __typename: 'SomethingNew',
                                                },
                                            ],
                                        },
                                    },
                                },
                            },
                        ],
                    },
                },
                baseRawPr,
            ].map((pr) => checkValidShape(pr, rawPrShape)),
            [
                false,
                false,
                true,
            ],
        );
    });
});
