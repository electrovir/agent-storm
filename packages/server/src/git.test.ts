// cspell:words gitdir

import {PrStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {calculateRelativeDate, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    buildPrsByBranch,
    listWorktreeChildren,
    parsePrsByBranch,
    removeWorktree,
    type OpenPrNode,
} from './git.js';
import {RawPrState} from './github-raw-enums.js';

const exec = promisify(execFile);

function daysAgoIso(days: number): string {
    return toUtcIsoString(
        calculateRelativeDate(getNowInUtcTimezone(), {
            days: -days,
        }),
    );
}

/** Fills in the fields a test doesn't care about, as GitHub answers for a PR without reviews. */
function openPrNodes(nodes: ReadonlyArray<Readonly<Partial<OpenPrNode>>>): OpenPrNode[] {
    return nodes.map((node) => {
        return {
            url: '',
            headRefName: '',
            state: RawPrState.Open,
            mergeStateStatus: '',
            body: '',
            latestOpinionatedReviews: {
                nodes: [],
            },
            viewerDidAuthor: false,
            reviewThreads: {
                nodes: [],
            },
            ...node,
        };
    });
}

describe(buildPrsByBranch.name, () => {
    it('keeps an open PR over a terminal one on the same branch', () => {
        const prs = buildPrsByBranch({
            openNodes: openPrNodes([
                {
                    url: 'https://github.com/owner/name/pull/2',
                    headRefName: 'feature',
                    state: RawPrState.Open,
                },
            ]),
            terminalNodes: [
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'feature',
                    state: RawPrState.Closed,
                    closedAt: daysAgoIso(1),
                },
            ],
        });
        assert.deepEquals(prs.get('feature'), {
            url: 'https://github.com/owner/name/pull/2',
            status: PrStatus.AwaitingReview,
        });
    });

    it('marks open PRs by the viewer review and merge readiness', () => {
        const prs = buildPrsByBranch({
            openNodes: openPrNodes([
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'approved',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                },
                {
                    url: 'https://github.com/owner/name/pull/2',
                    headRefName: 're-requested',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'CHANGES_REQUESTED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: {
                        id: 'RR_1',
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/3',
                    headRefName: 'clean',
                    state: RawPrState.Open,
                    mergeStateStatus: 'CLEAN',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'CHANGES_REQUESTED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                },
                {
                    url: 'https://github.com/owner/name/pull/4',
                    headRefName: 'mine',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    viewerDidAuthor: true,
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    reviewThreads: {
                        nodes: [
                            {
                                isResolved: false,
                            },
                        ],
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/5',
                    headRefName: 'commented',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [],
                    },
                    viewerLatestReviewRequest: null,
                    reviewThreads: {
                        nodes: [
                            {
                                isResolved: false,
                            },
                        ],
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/6',
                    headRefName: 'approved-by-others',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: false,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                },
                {
                    url: 'https://github.com/owner/name/pull/7',
                    headRefName: 'mine-awaiting-code-owner',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    viewerDidAuthor: true,
                    reviewDecision: 'REVIEW_REQUIRED',
                    headRef: {
                        target: {
                            statusCheckRollup: {
                                state: 'FAILURE',
                            },
                        },
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/9',
                    headRefName: 'approved-awaiting-code-owner-check',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    reviewDecision: 'APPROVED',
                    body: [
                        '<!-- code owners start -->',
                        '## Code Owners',
                        '<details>',
                        '<summary>@code-owner Owned files</summary>',
                        '',
                        '- [.github/workflows/build.yml](https://github.com/owner/name/pull/9/files)',
                        '',
                        '</details>',
                        '<!-- code owners end -->',
                    ].join('\n'),
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                    headRef: {
                        target: {
                            statusCheckRollup: {
                                state: 'FAILURE',
                            },
                        },
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/10',
                    headRefName: 'code-owner-approved-failing',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    reviewDecision: 'APPROVED',
                    body: [
                        '<!-- code owners start -->',
                        '## Code Owners',
                        '<details>',
                        '<summary>@code-owner Owned files</summary>',
                        '',
                        '- [.github/workflows/build.yml](https://github.com/owner/name/pull/9/files)',
                        '',
                        '</details>',
                        '<!-- code owners end -->',
                    ].join('\n'),
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: false,
                                author: {
                                    login: 'Code-Owner',
                                },
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                    headRef: {
                        target: {
                            statusCheckRollup: {
                                state: 'FAILURE',
                            },
                        },
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/11',
                    headRefName: 'approved-others-requested-changes',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                            {
                                state: 'CHANGES_REQUESTED',
                                viewerDidAuthor: false,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                },
                {
                    url: 'https://github.com/owner/name/pull/8',
                    headRefName: 'approved-failing',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    reviewDecision: 'APPROVED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                    headRef: {
                        target: {
                            statusCheckRollup: {
                                state: 'FAILURE',
                            },
                        },
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/9',
                    headRefName: 'approved-unresolved',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'APPROVED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                    reviewThreads: {
                        nodes: [
                            {
                                isResolved: false,
                            },
                        ],
                    },
                },
                {
                    url: 'https://github.com/owner/name/pull/10',
                    headRefName: 'changes-requested-unresolved',
                    state: RawPrState.Open,
                    mergeStateStatus: 'BLOCKED',
                    latestOpinionatedReviews: {
                        nodes: [
                            {
                                state: 'CHANGES_REQUESTED',
                                viewerDidAuthor: true,
                            },
                        ],
                    },
                    viewerLatestReviewRequest: null,
                    reviewThreads: {
                        nodes: [
                            {
                                isResolved: false,
                            },
                        ],
                    },
                },
            ]),
            terminalNodes: [],
        });
        assert.deepEquals(
            Array.from(prs.values(), (pr) => pr.status),
            [
                PrStatus.Approved,
                PrStatus.ReReviewRequested,
                PrStatus.ReadyToMerge,
                PrStatus.UnresolvedComments,
                PrStatus.UnresolvedComments,
                PrStatus.AwaitingReview,
                PrStatus.AwaitingOtherReviews,
                PrStatus.AwaitingOtherReviews,
                PrStatus.ChecksFailed,
                PrStatus.OthersRequestedChanges,
                PrStatus.ChecksFailed,
                PrStatus.UnresolvedComments,
                PrStatus.ChangesRequested,
            ],
        );
    });

    it('puts a review request ahead of a clean merge state', () => {
        const prs = buildPrsByBranch({
            openNodes: openPrNodes([
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'requested',
                    state: RawPrState.Open,
                    mergeStateStatus: 'CLEAN',
                    viewerLatestReviewRequest: {
                        id: 'RR_1',
                    },
                },
            ]),
            terminalNodes: [],
        });
        assert.strictEquals(prs.get('requested')?.status, PrStatus.AwaitingReview);
    });

    it('drops a terminal PR past the seven day window', () => {
        const prs = buildPrsByBranch({
            openNodes: [],
            terminalNodes: [
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'old',
                    state: RawPrState.Merged,
                    closedAt: daysAgoIso(8),
                },
                {
                    url: 'https://github.com/owner/name/pull/3',
                    headRefName: 'fresh',
                    state: RawPrState.Merged,
                    closedAt: daysAgoIso(2),
                },
            ],
        });
        assert.deepEquals(Array.from(prs.keys()), ['fresh']);
        assert.strictEquals(prs.get('fresh')?.status, PrStatus.Merged);
    });

    it('finds an open PR that merge churn would have pushed out of a single ordered list', () => {
        /**
         * The failure this guards: twenty PRs merged this week, and the one open PR on the
         * worktree's branch hasn't been updated since. A combined `first: 20` ordered by
         * `UPDATED_AT` returns only the merged ones and the branch loses its sidebar marker.
         */
        const prs = buildPrsByBranch({
            openNodes: openPrNodes([
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'stale-but-open',
                    state: RawPrState.Open,
                },
            ]),
            terminalNodes: createArray(20, (index) => {
                return {
                    url: `https://github.com/owner/name/pull/${index + 100}`,
                    headRefName: `merged-${index}`,
                    state: RawPrState.Merged,
                    closedAt: daysAgoIso(1),
                };
            }),
        });
        assert.isDefined(prs.get('stale-but-open'));
    });
});

describe(parsePrsByBranch.name, () => {
    function graphqlOutput(state: string) {
        return JSON.stringify({
            data: {
                repository: {
                    open: {
                        nodes: [],
                    },
                    terminal: {
                        nodes: [
                            {
                                url: 'https://github.com/owner/name/pull/1',
                                headRefName: 'feature',
                                state,
                                closedAt: daysAgoIso(1),
                            },
                        ],
                    },
                },
            },
        });
    }

    it('reads a well-formed answer', () => {
        assert.deepEquals(parsePrsByBranch(graphqlOutput(RawPrState.Merged)).get('feature'), {
            url: 'https://github.com/owner/name/pull/1',
            status: PrStatus.Merged,
        });
    });
    it('rejects a PR state the query never returns', () => {
        assert.throws(() => parsePrsByBranch(graphqlOutput('DRAFT')));
    });
    it('reads a missing repository as no PRs', () => {
        assert.strictEquals(
            parsePrsByBranch(
                JSON.stringify({
                    data: {
                        repository: null,
                    },
                }),
            ).size,
            0,
        );
    });
});

async function git({
    cwd,
    args,
}: Readonly<{
    cwd: string;
    args: ReadonlyArray<string>;
}>): Promise<void> {
    await exec('git', [...args], {
        cwd,
    });
}

describe(removeWorktree.name, () => {
    async function initRepo({
        parent,
        mainPath,
    }: Readonly<{
        parent: string;
        mainPath: string;
    }>): Promise<void> {
        await git({
            cwd: parent,
            args: [
                'init',
                'main',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'config',
                'user.email',
                'test@example.com',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'config',
                'user.name',
                'Test User',
            ],
        });
        await writeFile(join(mainPath, 'tracked.txt'), 'base\n');
        await git({
            cwd: mainPath,
            args: [
                'add',
                'tracked.txt',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'commit',
                '-m',
                'Initial commit',
            ],
        });
    }

    it('removes dirty locked worktrees', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'agent-storm-git-'));
        const mainPath = join(parent, 'main');
        const worktreePath = join(parent, 'feature-work-item');
        try {
            await initRepo({
                parent,
                mainPath,
            });
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'add',
                    '../feature-work-item',
                ],
            });
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'lock',
                    '../feature-work-item',
                ],
            });
            await writeFile(join(worktreePath, 'tracked.txt'), 'changed\n');
            await writeFile(join(worktreePath, 'untracked.txt'), 'untracked\n');

            await removeWorktree({
                worktreePath,
            });

            const removedWorktree = await stat(worktreePath).catch(() => undefined);
            const remainingChildren = await listWorktreeChildren(parent);

            assert.deepEquals(
                {
                    removedWorktree: !!removedWorktree,
                    remainingChildren,
                },
                {
                    removedWorktree: false,
                    remainingChildren: [
                        mainPath,
                    ],
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });

    it('removes filesystem worktree-looking folders when git removal rejects them', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'agent-storm-git-'));
        const mainPath = join(parent, 'main');
        const worktreePath = join(parent, 'orphaned-worktree');
        try {
            await initRepo({
                parent,
                mainPath,
            });
            await mkdir(worktreePath);
            await writeFile(join(worktreePath, '.git'), 'gitdir: /missing/gitdir\n');
            await writeFile(join(worktreePath, 'untracked.txt'), 'untracked\n');

            await removeWorktree({
                worktreePath,
            });

            const removedWorktree = await stat(worktreePath).catch(() => undefined);
            const remainingChildren = await listWorktreeChildren(parent);

            assert.deepEquals(
                {
                    removedWorktree: !!removedWorktree,
                    remainingChildren,
                },
                {
                    removedWorktree: false,
                    remainingChildren: [
                        mainPath,
                    ],
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});
