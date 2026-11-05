import {GitHubReviewState, PrStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {RawActorType, RawAuthorAssociation, RawMergeState} from './github-raw-enums.js';
import {
    organizeAssigneeQueue,
    organizeReviewQueue,
    toReviewers,
    toViewerReviewRequests,
    type RawReviewPr,
} from './github-review-queue.js';

const login = 'reviewer';

describe(toReviewers.name, () => {
    function createVerdict(author: string, state: GitHubReviewState) {
        return {
            id: `review-${author}`,
            author,
            authorAvatarUrl: `https://example.com/${author}.png`,
            state,
            body: '',
            bodyHtml: '',
            createdAt: '2026-01-01T00:00:00Z',
            url: '',
        };
    }

    it('lets an outstanding request replace an earlier verdict and sorts by login', () => {
        assert.deepEquals(
            toReviewers({
                requests: [
                    {
                        reviewer: 'carol',
                        reviewerAvatarUrl: 'https://example.com/carol.png',
                    },
                ],
                verdicts: [
                    createVerdict('carol', GitHubReviewState.ChangesRequested),
                    createVerdict('bob', GitHubReviewState.Approved),
                ],
            }).map((reviewer) => {
                return {
                    login: reviewer.login,
                    state: reviewer.state,
                };
            }),
            [
                {
                    login: 'bob',
                    state: GitHubReviewState.Approved,
                },
                {
                    login: 'carol',
                    state: GitHubReviewState.Pending,
                },
            ],
        );
    });
});

function createPr({
    number,
    ...overrides
}: Readonly<Partial<RawReviewPr> & {number: number}>): RawReviewPr {
    return {
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        title: `PR ${number}`,
        titleHTML: `PR ${number}`,
        body: '',
        bodyHTML: '',
        bodyText: '',
        createdAt: '2026-01-01T00:00:00Z',
        isDraft: false,
        reviewDecision: null,
        mergeStateStatus: RawMergeState.Blocked,
        reviewThreads: {
            nodes: [],
        },
        timelineItems: {
            nodes: [],
        },
        viewerLatestReview: null,
        viewerLatestReviewRequest: null,
        viewerDidAuthor: false,
        author: {
            __typename: RawActorType.User,
            login: 'author',
            avatarUrl: 'https://example.com/author.png',
        },
        authorAssociation: RawAuthorAssociation.Member,
        assignees: {
            nodes: [],
        },
        latestOpinionatedReviews: {
            nodes: [],
        },
        baseRef: {
            name: 'main',
        },
        headRef: {
            name: `branch-${number}`,
            target: null,
        },
        baseRepository: {
            name: 'app',
            owner: {
                login: 'acme',
            },
        },
        headRepository: {
            name: 'app',
            owner: {
                login: 'acme',
            },
        },
        ...overrides,
    };
}

function listedNumbers(prs: ReadonlyArray<RawReviewPr>) {
    return organizeReviewQueue({
        prs,
        login,
    }).map((pr) => pr.number);
}

describe(organizeReviewQueue.name, () => {
    it('lists the author as the assignee when there are none', () => {
        assert.deepEquals(
            organizeReviewQueue({
                prs: [
                    createPr({
                        number: 1,
                    }),
                ],
                login,
            })[0]?.assignees,
            [
                {
                    login: 'author',
                    avatarUrl: 'https://example.com/author.png',
                },
            ],
        );
    });

    it('trusts collaborators and trusted bots but not outsiders posing as a bot login', () => {
        const botAuthor = {
            login: 'copilot',
            avatarUrl: 'https://example.com/copilot.png',
        };
        assert.deepEquals(
            organizeReviewQueue({
                prs: [
                    createPr({
                        number: 1,
                    }),
                    createPr({
                        number: 2,
                        authorAssociation: RawAuthorAssociation.None,
                        author: {
                            ...botAuthor,
                            __typename: RawActorType.Bot,
                        },
                    }),
                    createPr({
                        number: 3,
                        authorAssociation: RawAuthorAssociation.None,
                        author: {
                            ...botAuthor,
                            __typename: RawActorType.User,
                        },
                    }),
                    createPr({
                        number: 4,
                        authorAssociation: RawAuthorAssociation.Contributor,
                    }),
                ],
                login,
            }).map((pr) => {
                return {
                    number: pr.number,
                    isAuthorTrusted: pr.isAuthorTrusted,
                };
            }),
            [
                {
                    number: 1,
                    isAuthorTrusted: true,
                },
                {
                    number: 2,
                    isAuthorTrusted: true,
                },
                {
                    number: 3,
                    isAuthorTrusted: false,
                },
                {
                    number: 4,
                    isAuthorTrusted: false,
                },
            ],
        );
    });

    it('puts primary reviews first and stacked PRs under their parent', () => {
        assert.deepEquals(
            listedNumbers([
                createPr({
                    number: 1,
                }),
                createPr({
                    number: 2,
                    baseRef: {
                        name: 'branch-3',
                    },
                }),
                createPr({
                    number: 3,
                    bodyText: `Primary reviewer: @${login}`,
                }),
            ]),
            [
                3,
                2,
                1,
            ],
        );
    });

    it('nests each stacked PR one level under its parent', () => {
        assert.deepEquals(
            organizeReviewQueue({
                prs: [
                    createPr({
                        number: 1,
                    }),
                    createPr({
                        number: 2,
                        baseRef: {
                            name: 'branch-1',
                        },
                    }),
                    createPr({
                        number: 3,
                        baseRef: {
                            name: 'branch-2',
                        },
                    }),
                ],
                login,
            }).map((pr) => {
                return {
                    number: pr.number,
                    chainDepth: pr.chainDepth,
                };
            }),
            [
                {
                    number: 1,
                    chainDepth: 0,
                },
                {
                    number: 2,
                    chainDepth: 1,
                },
                {
                    number: 3,
                    chainDepth: 2,
                },
            ],
        );
    });

    it('lists each PR once when PRs from the same head branch stack on each other', () => {
        assert.deepEquals(
            listedNumbers([
                createPr({
                    number: 1,
                    headRef: {
                        name: 'shared',
                        target: null,
                    },
                }),
                createPr({
                    number: 2,
                    baseRef: {
                        name: 'shared',
                    },
                }),
                createPr({
                    number: 3,
                    headRef: {
                        name: 'shared',
                        target: null,
                    },
                    baseRef: {
                        name: 'branch-2',
                    },
                }),
            ]),
            [
                1,
                2,
                3,
            ],
        );
    });

    it('leaves out PRs whose head branch name is unsafe', () => {
        assert.deepEquals(
            listedNumbers([
                createPr({
                    number: 1,
                }),
                createPr({
                    number: 2,
                    headRef: {
                        name: '../../escape',
                        target: null,
                    },
                }),
            ]),
            [
                1,
            ],
        );
    });

    it('groups by owner alphabetically', () => {
        assert.deepEquals(
            listedNumbers([
                createPr({
                    number: 1,
                    baseRepository: {
                        name: 'site',
                        owner: {
                            login: 'zeta',
                        },
                    },
                }),
                createPr({
                    number: 2,
                }),
            ]),
            [
                2,
                1,
            ],
        );
    });
});

describe(toViewerReviewRequests.name, () => {
    it('keeps only requests for the viewer and marks every one after the first as a re-request', () => {
        assert.deepEquals(
            toViewerReviewRequests({
                events: [
                    'RR_1',
                    'RR_2',
                    'RR_3',
                ].map((id, index) => {
                    return {
                        id,
                        createdAt: `2026-01-0${index + 1}T00:00:00Z`,
                        actor: {
                            login: 'author',
                            avatarUrl: 'https://example.com/author.png',
                        },
                        requestedReviewer: {
                            login: id === 'RR_2' ? 'someone-else' : login,
                        },
                    };
                }),
                login,
            }).map((request) => {
                return {
                    id: request.id,
                    isReRequest: request.isReRequest,
                };
            }),
            [
                {
                    id: 'RR_1',
                    isReRequest: false,
                },
                {
                    id: 'RR_3',
                    isReRequest: true,
                },
            ],
        );
    });
});

describe(organizeAssigneeQueue.name, () => {
    it('marks the PRs the viewer wrote', () => {
        assert.deepEquals(
            organizeAssigneeQueue({
                login,
                prs: [
                    createPr({
                        number: 1,
                    }),
                    createPr({
                        number: 2,
                        author: {
                            __typename: RawActorType.User,
                            login,
                            avatarUrl: 'https://example.com/reviewer.png',
                        },
                    }),
                ],
            }).map((pr) => pr.isViewerAuthor),
            [
                false,
                true,
            ],
        );
    });

    it('puts drafts after ready PRs', () => {
        assert.deepEquals(
            organizeAssigneeQueue({
                login,
                prs: [
                    createPr({
                        number: 1,
                        isDraft: true,
                    }),
                    createPr({
                        number: 2,
                        createdAt: '2026-02-01T00:00:00Z',
                    }),
                ],
            }).map((pr) => pr.number),
            [
                2,
                1,
            ],
        );
    });

    it('gives each PR the same status the Build tab gives it', () => {
        assert.deepEquals(
            organizeAssigneeQueue({
                login,
                prs: [
                    createPr({
                        number: 1,
                        mergeStateStatus: RawMergeState.Clean,
                    }),
                    createPr({
                        number: 2,
                        viewerLatestReviewRequest: {
                            id: 'request',
                        },
                        reviewThreads: {
                            nodes: [
                                {
                                    isResolved: false,
                                },
                            ],
                        },
                    }),
                    createPr({
                        number: 3,
                        reviewThreads: {
                            nodes: [
                                {
                                    isResolved: false,
                                },
                            ],
                        },
                    }),
                ],
            })
                .map((pr) => {
                    return {
                        number: pr.number,
                        prStatus: pr.prStatus,
                    };
                })
                .toSorted((a, b) => a.number - b.number),
            [
                {
                    number: 1,
                    prStatus: PrStatus.ReadyToMerge,
                },
                {
                    number: 2,
                    prStatus: PrStatus.AwaitingReview,
                },
                {
                    number: 3,
                    prStatus: PrStatus.UnresolvedComments,
                },
            ],
        );
    });
});
