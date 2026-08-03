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
import {toPr} from './github-pr.js';

/** Minimal PR node; each test overrides only the fields it exercises. */
const baseRawPr = {
    id: 'PR_1',
    number: 7,
    url: 'https://github.com/owner/name/pull/7',
    title: 'Add a thing',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'dev',
    headRefName: 'feature',
    author: {
        login: 'electrovir',
        avatarUrl: 'https://avatars.example/electrovir',
    },
};

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
            'FAILURE',
            'ERROR',
        ].map(
            (state) =>
                toPr({
                    ...baseRawPr,
                    commits: {
                        nodes: [
                            {
                                commit: {
                                    statusCheckRollup: {
                                        state,
                                    },
                                },
                            },
                        ],
                    },
                }).checks,
        );
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
                        id: 'IC_1',
                        body: 'looks good',
                        createdAt: '2026-08-01T00:00:00Z',
                        url: 'https://github.com/owner/name/pull/7#issuecomment-1',
                        author: {
                            login: 'reviewer',
                        },
                        reactionGroups: [
                            {
                                content: 'THUMBS_UP',
                                viewerHasReacted: true,
                                reactors: {
                                    totalCount: 2,
                                },
                            },
                            {
                                content: 'CONFUSED',
                                viewerHasReacted: false,
                                reactors: {
                                    totalCount: 0,
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
            },
        ]);
    });

    it('names a deleted comment author ghost', () => {
        const pr = toPr({
            ...baseRawPr,
            comments: {
                nodes: [
                    {
                        id: 'IC_1',
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
                                    id: 'RC_1',
                                    diffHunk: '@@ -1 +1 @@',
                                },
                                {
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
            commits: {
                nodes: [
                    {
                        commit: {
                            statusCheckRollup: {
                                state: 'PENDING',
                                contexts: {
                                    nodes: [
                                        {
                                            __typename: 'CheckRun',
                                            name: 'build (ubuntu-latest)',
                                            conclusion: null,
                                            status: 'IN_PROGRESS',
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
                            },
                        },
                    },
                ],
            },
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

    it('separates real check failures from cancelled and skipped runs', () => {
        const pr = toPr({
            ...baseRawPr,
            commits: {
                nodes: [
                    {
                        commit: {
                            statusCheckRollup: {
                                state: 'FAILURE',
                                contexts: {
                                    nodes: [
                                        {
                                            __typename: 'CheckRun',
                                            name: 'lint',
                                            conclusion: 'TIMED_OUT',
                                        },
                                        {
                                            __typename: 'CheckRun',
                                            name: 'docs',
                                            conclusion: 'SKIPPED',
                                        },
                                        {
                                            __typename: 'StatusContext',
                                            context: 'ci/external',
                                            state: 'SUCCESS',
                                            targetUrl: 'https://ci.example/1',
                                            description: 'all good',
                                        },
                                    ],
                                },
                            },
                        },
                    },
                ],
            },
        });
        assert.deepEquals(
            pr.checkRuns.map((checkRun) =>
                selectFrom(checkRun, {
                    name: true,
                    state: true,
                }),
            ),
            [
                {
                    name: 'lint',
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
                        id: 'PRR_1',
                        state: 'SOMETHING_NEW',
                        author: {
                            login: 'reviewer',
                        },
                    },
                ],
            },
        });
        assert.strictEquals(pr.reviews[0]?.state, GitHubReviewState.Commented);
    });
});
