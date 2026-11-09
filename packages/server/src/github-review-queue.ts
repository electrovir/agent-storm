// cspell:words unresolve

import {
    ForgeType,
    GitHubReviewState,
    ManualReviewStatus,
    PaneKind,
    PaneStatus,
    PrStatus,
    type GitHubReview,
    type GitHubReviewRequest,
    type PullRequestBranch,
    type PullRequestRef,
    type ReviewPr,
    type ReviewQueue,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {
    awaitedBlockingMap,
    extractErrorMessage,
    log,
    removeDuplicates,
    type MaybePromise,
} from '@augment-vir/common';
import {doesPathContain} from '@augment-vir/node';
import {convertDuration, type AnyDuration} from 'date-vir';
import {mkdir, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {
    assertWrapValidShape,
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
} from 'object-shape-tester';
import {isSafeBranchName} from './branch-name.js';
import {readBranchPrStatus, recordBranchPr} from './branch-prs.js';
import {fetchPaneStatuses, killFolderPanes} from './daemon/daemon-client.js';
import {closeEditorWindow} from './editor-window.js';
import {manualReviewSkillDir} from './file-paths.js';
import {deleteReviewFolder, parseInsertedCodeOwners, toOpenPrStatus} from './git.js';
import {
    commentFields,
    rawReviewRequestShape,
    rawReviewShape,
    rawThreadFields,
    reviewFields,
    reviewRequestFields,
    runGraphql,
    toReview,
    toReviewRequests,
    toThread,
} from './github-pr.js';
import {
    collaboratorAssociations,
    isTrustedBot,
    RawActorType,
    RawAuthorAssociation,
    RawCheckResult,
    RawMergeState,
    RawPrState,
    RawReviewDecision,
    RawReviewState,
    RawThreadSubjectType,
} from './github-raw-enums.js';
import {
    listenToManualReviewState,
    postedVerdictStatuses,
    readManualReviewEntry,
    readManualReviewState,
    toReviewFolder,
} from './manual-review-state.js';
import {getPaneStatusLookup} from './pty.js';
import {loadSettings} from './settings.js';
import {deleteFolderState} from './ui-layout.js';

const githubUserFields = {
    login: '',
    avatarUrl: '',
};

/**
 * Everything review-vir's ordering reads from one PR awaiting review, as GitHub's search returns
 * it.
 */
const rawReviewPrShape = defineShape({
    number: 0,
    url: '',
    title: '',
    titleHTML: '',
    body: '',
    bodyHTML: '',
    bodyText: '',
    createdAt: '',
    isDraft: false,
    /** Null when the base branch requires no reviews. */
    reviewDecision: nullableShape(enumShape(RawReviewDecision)),
    mergeStateStatus: enumShape(RawMergeState),
    reviewThreads: {
        nodes: [
            {
                isResolved: false,
            },
        ],
    },
    /** Only the latest `ReadyForReviewEvent`, if there is one. */
    timelineItems: {
        nodes: [
            {
                createdAt: optionalShape(''),
            },
        ],
    },
    /** The viewer's latest review of any kind. `submittedAt` is null while it's pending. */
    viewerLatestReview: nullableShape({
        submittedAt: nullableShape(''),
    }),
    author: nullableShape({
        ...githubUserFields,
        __typename: enumShape(RawActorType),
    }),
    authorAssociation: enumShape(RawAuthorAssociation),
    assignees: {
        nodes: [
            githubUserFields,
        ],
    },
    viewerDidAuthor: false,
    viewerLatestReviewRequest: nullableShape({
        id: '',
    }),
    /** Each reviewer's latest approval or change request. Comment-only reviews aren't listed. */
    latestOpinionatedReviews: {
        nodes: [
            {
                state: enumShape(RawReviewState),
                viewerDidAuthor: false,
                author: nullableShape({
                    login: '',
                }),
            },
        ],
    },
    baseRef: nullableShape({
        name: '',
    }),
    headRefOid: '',
    headRef: nullableShape({
        name: '',
        /** Has no `statusCheckRollup` when the branch points at something other than a commit. */
        target: nullableShape({
            statusCheckRollup: optionalShape(
                nullableShape({
                    state: enumShape(RawCheckResult),
                }),
            ),
        }),
    }),
    baseRepository: {
        name: '',
        owner: {
            login: '',
        },
    },
    /** Null once the fork the PR came from is deleted. */
    headRepository: nullableShape({
        name: '',
        owner: {
            login: '',
        },
    }),
});

/** Exported for tests. */
export type RawReviewPr = typeof rawReviewPrShape.runtimeType;

type ChainedPr = {
    pr: Readonly<RawReviewPr>;
    children: ChainedPr[];
};

const userFields = 'login avatarUrl';

const searchGraphql = [
    'query($afterCursor: String, $searchQuery: String!) {',
    '  viewer { login }',
    '  rateLimit { cost }',
    /**
     * GitHub charges a point per hundred nested lists the page could return, rounded to the nearest
     * point, and each PR below has four: this is the largest page that still costs 1 point.
     */
    '  search(first: 37, after: $afterCursor, query: $searchQuery, type: ISSUE) {',
    '    pageInfo { endCursor hasNextPage }',
    '    nodes {',
    '      ... on PullRequest {',
    '        number url title titleHTML body bodyHTML bodyText createdAt isDraft reviewDecision mergeStateStatus viewerDidAuthor authorAssociation headRefOid',
    '        viewerLatestReview { submittedAt }',
    '        viewerLatestReviewRequest { id }',
    '        reviewThreads(first: 100) { nodes { isResolved } }',
    '        timelineItems(last: 1, itemTypes: [READY_FOR_REVIEW_EVENT]) { nodes { ... on ReadyForReviewEvent { createdAt } } }',
    `        author { __typename ${userFields} }`,
    `        assignees(first: 10) { nodes { ${userFields} } }`,
    '        latestOpinionatedReviews(first: 20) { nodes { state viewerDidAuthor author { login } } }',
    '        baseRef { name }',
    '        headRef { name target { ... on Commit { statusCheckRollup { state } } } }',
    '        baseRepository { name owner { login } }',
    '        headRepository { name owner { login } }',
    '      }',
    '    }',
    '  }',
    '}',
].join('\n');

const searchPageShape = defineShape({
    viewer: {
        login: '',
    },
    rateLimit: {
        cost: 0,
    },
    search: {
        pageInfo: {
            endCursor: nullableShape(''),
            hasNextPage: false,
        },
        nodes: [
            rawReviewPrShape,
        ],
    },
});

/**
 * A search can match far more PRs than any queue shows, so its pages stop here rather than spending
 * the rate limit on them.
 */
const maxSearchPages = 10;

/** Review-vir's auto-update interval, before stretching it for query cost. */
const baseUpdateInterval: AnyDuration = {
    minutes: 1,
};

/**
 * Review-vir's GitHub `maxQueryCost`: an update costing more GraphQL rate-limit points than this
 * stretches the wait before the next one in proportion.
 */
const maxQueryCostPerInterval = 3;

/**
 * How long a queue that only feeds the UI keeps updating after the last browser read it. Past this
 * it stops spending rate limit until the next read.
 */
const unreadQueueTimeout: AnyDuration = {
    minutes: 5,
};

/**
 * A server-side cache of one GitHub PR list. Nothing is fetched until the first `read`, which
 * starts review-vir's update cadence: the next update is scheduled only once the current one lands,
 * and the wait grows with the cost of the last successful update.
 */
function createPrQueue({
    searchQueries,
    organize,
    afterUpdate,
}: Readonly<{
    /** Every PR matching any of these searches is listed once. */
    searchQueries: ReadonlyArray<string>;
    organize: (
        params: Readonly<{
            prs: ReadonlyArray<Readonly<RawReviewPr>>;
            login: string;
            trustedBotLogins: ReadonlyArray<string>;
        }>,
    ) => ReviewQueuePr[];
    afterUpdate?:
        | ((pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => Promise<void>)
        | undefined;
}>) {
    const cache: Omit<ReviewQueue, 'isUpdating'> & {
        /** The `gh` account, empty until the first successful fetch. */
        viewerLogin: string;
        latestQueryCost: number;
        inFlightUpdate: Promise<void> | undefined;
        hasStartedAutoUpdates: boolean;
        lastReadAt: number;
    } = {
        pullRequests: [],
        updatedAt: 0,
        error: '',
        viewerLogin: '',
        latestQueryCost: 0,
        inFlightUpdate: undefined,
        hasStartedAutoUpdates: false,
        lastReadAt: 0,
    };

    /**
     * Statuses come from the server's shared branch store, so a newer answer from the Build tab's
     * lookups shows here too.
     */
    async function snapshot() {
        const statusLookup = await getPaneStatusLookup();
        return {
            pullRequests: await Promise.all(
                cache.pullRequests.map(async (pr) => {
                    const folder = toReviewFolder(pr);
                    return {
                        ...pr,
                        panes: {
                            [PaneKind.Ai]: statusLookup(folder, PaneKind.Ai),
                            [PaneKind.Shell]: statusLookup(folder, PaneKind.Shell),
                        },
                        prStatus: await applyManualReviewStatus({
                            prStatus:
                                readBranchPrStatus({
                                    owner: pr.owner,
                                    name: pr.repoName,
                                    branchName: pr.branchName,
                                    url: pr.url,
                                }) || pr.prStatus,
                            owner: pr.owner,
                            repoName: pr.repoName,
                            branchName: pr.branchName,
                        }),
                    };
                }),
            ),
            updatedAt: cache.updatedAt,
            isUpdating: !!cache.inFlightUpdate,
            error: cache.error,
        };
    }

    async function fetchIntoCache() {
        try {
            const pages = (
                await Promise.all(
                    searchQueries.map(async (searchQuery) => {
                        return await fetchSearchPages({
                            searchQuery,
                            afterCursor: undefined,
                            pageIndex: 0,
                        });
                    }),
                )
            ).flat();
            cache.viewerLogin = pages[0]?.viewer.login || cache.viewerLogin;
            cache.pullRequests = organize({
                prs: removeDuplicates(
                    pages.flatMap((page) => page.search.nodes),
                    (pr) => pr.url,
                ),
                login: cache.viewerLogin,
                trustedBotLogins: (await loadSettings()).forges[ForgeType.Github].trustedBotLogins,
            });
            cache.pullRequests
                .filter((pr) => pr.branchName)
                .forEach((pr) => {
                    recordBranchPr({
                        owner: pr.owner,
                        name: pr.repoName,
                        branchName: pr.branchName,
                        prInfo: {
                            url: pr.url,
                            status: pr.prStatus,
                        },
                    });
                });
            cache.latestQueryCost = pages.reduce((total, page) => total + page.rateLimit.cost, 0);
            cache.updatedAt = Date.now();
            cache.error = '';
        } catch (error) {
            cache.error = extractErrorMessage(error);
            return;
        }
        await afterUpdate?.(cache.pullRequests);
    }

    function update() {
        cache.inFlightUpdate ??= fetchIntoCache().finally(() => {
            cache.inFlightUpdate = undefined;
        });
        return cache.inFlightUpdate;
    }

    async function runScheduledUpdate() {
        await update();
        if (
            !afterUpdate &&
            Date.now() - cache.lastReadAt >
                convertDuration(unreadQueueTimeout, {
                    milliseconds: true,
                }).milliseconds
        ) {
            cache.hasStartedAutoUpdates = false;
            return;
        }
        const costMultiplier = Math.max(1, cache.latestQueryCost / maxQueryCostPerInterval);
        setTimeout(
            () => {
                void runScheduledUpdate();
            },
            convertDuration(baseUpdateInterval, {
                milliseconds: true,
            }).milliseconds * costMultiplier,
        );
    }

    /** The cached list. The first call starts the auto-refresh loop. */
    async function read() {
        cache.lastReadAt = Date.now();
        if (!cache.hasStartedAutoUpdates) {
            cache.hasStartedAutoUpdates = true;
            void runScheduledUpdate();
        }
        return await snapshot();
    }

    /** Fetches now, or joins the fetch already running, and answers with the result. */
    async function refresh() {
        await update();
        return await snapshot();
    }

    return {
        cache,
        update,
        read,
        refresh,
    };
}

const reviewQueue = createPrQueue({
    searchQueries: [
        'is:open is:pr archived:false draft:false user-review-requested:@me -assignee:@me',
    ],
    organize: organizeReviewQueue,
    async afterUpdate(pullRequests) {
        await handleDroppedReviewFolders();
        queueHooks.afterReviewUpdate?.(pullRequests);
    },
});

const queueHooks: {
    afterReviewUpdate: ((pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => void) | undefined;
    afterAssigneeUpdate: ReadonlyArray<
        (pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => MaybePromise<void>
    >;
} = {
    afterReviewUpdate: undefined,
    afterAssigneeUpdate: [],
};

/** Calls `listener` after every update of the Reviewer list. Replaces any earlier listener. */
export function listenToReviewQueue(
    listener: (pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => void,
) {
    queueHooks.afterReviewUpdate = listener;
}

/** Calls `listener` after every update of the Assignee list, alongside any earlier listeners. */
export function listenToAssigneeQueue(
    listener: (pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) => MaybePromise<void>,
) {
    queueHooks.afterAssigneeUpdate = [
        ...queueHooks.afterAssigneeUpdate,
        listener,
    ];
}

/**
 * Review-vir counts the author as the assignee when a PR has none, hence the second search.
 * `review-vir/private-test` holds a test PR that review-vir itself doesn't list.
 */
const assigneeQueue = createPrQueue({
    searchQueries: [
        'is:open is:pr archived:false assignee:@me -repo:review-vir/private-test',
        'is:open is:pr archived:false author:@me no:assignee -repo:review-vir/private-test',
    ],
    organize: organizeAssigneeQueue,
    async afterUpdate(pullRequests) {
        await handleDroppedReviewFolders();
        await Promise.all(
            queueHooks.afterAssigneeUpdate.map(async (listener) => {
                await listener(pullRequests);
            }),
        );
    },
});

/**
 * GitHub's search index lags a review by minutes, so a PR the viewer just approved or rejected can
 * still match `user-review-requested:@me`. The PR's own `viewerLatestReviewRequest` is current, so
 * this drops the stale matches.
 */
function filterAwaitingViewer(pullRequests: ReadonlyArray<Readonly<ReviewQueuePr>>) {
    return pullRequests.filter((pr) => pr.isAwaitingViewerReview);
}

/** Every queued PR that can get a review folder: the viewer's own PRs can't. */
function listReviewablePrs() {
    return [
        ...filterAwaitingViewer(reviewQueue.cache.pullRequests),
        ...assigneeQueue.cache.pullRequests.filter((pr) => !pr.isViewerAuthor),
    ];
}

/**
 * PRs the viewer has reviewed that no longer wait on that review. Left out of
 * {@link listReviewablePrs}, so they get no review folder, the same as a PR leaving the Reviewer
 * list.
 */
const reviewedQueue = createPrQueue({
    searchQueries: [
        'is:open is:pr archived:false draft:false reviewed-by:@me -user-review-requested:@me -assignee:@me -author:@me',
    ],
    organize: organizeReviewQueue,
});

function combineReviewerQueues([
    queue,
    reviewed,
]: Readonly<
    [
        ReviewQueue,
        ReviewQueue,
    ]
>) {
    const staleRequests = queue.pullRequests.filter((pr) => !pr.isAwaitingViewerReview);
    return {
        ...queue,
        pullRequests: filterAwaitingViewer(queue.pullRequests),
        reviewedPullRequests: [
            ...staleRequests,
            ...reviewed.pullRequests.filter((pr) => {
                return !staleRequests.some((stale) => stale.url === pr.url);
            }),
        ],
        isUpdating: queue.isUpdating || reviewed.isUpdating,
        error: queue.error || reviewed.error,
    };
}

export async function readReviewQueue() {
    return combineReviewerQueues(
        await Promise.all([
            reviewQueue.read(),
            reviewedQueue.read(),
        ]),
    );
}

export async function refreshReviewQueue() {
    return combineReviewerQueues(
        await Promise.all([
            reviewQueue.refresh(),
            reviewedQueue.refresh(),
        ]),
    );
}

export const readAssigneeQueue = assigneeQueue.read;
export const refreshAssigneeQueue = assigneeQueue.refresh;

/** The `gh` account's login. Fetches the Reviewer list when it hasn't been fetched yet. */
export async function readViewerLogin() {
    if (!reviewQueue.cache.viewerLogin) {
        await reviewQueue.update();
    }
    if (!reviewQueue.cache.viewerLogin) {
        throw new Error(
            `Couldn't read your GitHub login: ${reviewQueue.cache.error || 'unknown error'}`,
        );
    }
    return reviewQueue.cache.viewerLogin;
}

async function handleDroppedReviewFolders() {
    /** Until both queues have loaded, a folder missing from them may only be in the other one. */
    if (!reviewQueue.cache.updatedAt || !assigneeQueue.cache.updatedAt) {
        return;
    }
    const queuedFolders = listReviewablePrs().map(toReviewFolder);
    await killDroppedReviewPanes(queuedFolders);
    await deleteClosedReviewFolders(queuedFolders);
}

/**
 * Kills the processes of every pane open in a review folder whose PR has left the queue, keeping
 * its tabs. Reads the daemon's panes rather than diffing against the previous fetch, so panes that
 * outlived a server restart are caught too.
 */
async function killDroppedReviewPanes(queuedFolders: ReadonlyArray<string>) {
    try {
        const droppedFolders = removeDuplicates(
            (await fetchPaneStatuses()).map((pane) => pane.folder),
        ).filter((folder) => {
            return (
                doesPathContain({
                    potentialParentPath: manualReviewSkillDir,
                    potentialChildPath: folder,
                }) && !queuedFolders.includes(folder)
            );
        });
        await Promise.all(
            droppedFolders.map(async (folder) => {
                await killFolderPanes({
                    folder,
                });
            }),
        );
    } catch {
        /** An unreachable daemon only delays this to the next queue update. */
    }
}

const reviewFolderCleanupInterval: AnyDuration = {
    hours: 1,
};
const reviewFolderCleanup = {
    lastRunAt: 0,
};

/**
 * Deletes the review folders whose PR is no longer open. A PR can leave both queues while still
 * open (the review was posted, or it went back to draft), so leaving the queue isn't enough. A
 * folder is kept whenever GitHub can't answer for it, since it may hold review comments that were
 * never posted.
 */
async function deleteClosedReviewFolders(queuedFolders: ReadonlyArray<string>) {
    const now = Date.now();
    if (
        now - reviewFolderCleanup.lastRunAt <
        convertDuration(reviewFolderCleanupInterval, {
            milliseconds: true,
        }).milliseconds
    ) {
        return;
    }
    reviewFolderCleanup.lastRunAt = now;
    try {
        const droppedFolders = (await listReviewFolders()).filter((reviewFolder) => {
            return !queuedFolders.includes(toReviewFolder(reviewFolder));
        });
        /** One PR at a time, so a big backlog doesn't spend the rate limit in a burst. */
        const closedFolders = (
            await awaitedBlockingMap(droppedFolders, async (reviewFolder) => {
                return (await isPrClosed(reviewFolder))
                    ? [
                          toReviewFolder(reviewFolder),
                      ]
                    : [];
            })
        ).flat();
        await Promise.all(closedFolders.map(deleteReviewFolder));
        await Promise.all(closedFolders.map(deleteFolderState));
        if (closedFolders.length) {
            log.info(
                [
                    'Deleted review folders whose PR is no longer open:',
                    ...closedFolders,
                ].join('\n'),
            );
        }
    } catch (error) {
        log.warning(`Review folder cleanup failed: ${extractErrorMessage(error)}`);
    }
}

async function listSubfolderNames(folder: string) {
    return (
        await readdir(folder, {
            withFileTypes: true,
        }).catch(() => [])
    )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
}

/** Every `<owner>/<repo>/<PR number>` folder in {@link manualReviewSkillDir}. */
async function listReviewFolders() {
    const owners = await listSubfolderNames(manualReviewSkillDir);
    return (
        await Promise.all(
            owners.map(async (owner) => {
                const repoNames = await listSubfolderNames(join(manualReviewSkillDir, owner));
                return (
                    await Promise.all(
                        repoNames.map(async (repoName) => {
                            return (
                                await listSubfolderNames(
                                    join(manualReviewSkillDir, owner, repoName),
                                )
                            )
                                .filter((name) => /^[1-9]\d*$/.test(name))
                                .map((name) => {
                                    return {
                                        owner,
                                        repoName,
                                        number: Number(name),
                                    };
                                });
                        }),
                    )
                ).flat();
            }),
        )
    ).flat();
}

const prStateResponseShape = defineShape({
    repository: nullableShape({
        pullRequest: nullableShape({
            state: enumShape(RawPrState),
        }),
    }),
});

/** False whenever GitHub can't say, including for a PR it doesn't know. */
async function isPrClosed({owner, repoName, number}: Readonly<PullRequestRef>) {
    try {
        const state = assertWrapValidShape(
            await runGraphql(
                /** `runGraphql` sends every variable as a string, so the number is written in. */
                `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequest(number: ${number}) { state } } }`,
                {
                    owner,
                    name: repoName,
                },
            ),
            prStateResponseShape,
        ).repository?.pullRequest?.state;
        return !!state && state !== RawPrState.Open;
    } catch {
        return false;
    }
}

/** Statuses that become `ReviewStarted` once the manual-review skill starts on the branch. */
const owedReviewStatuses: Readonly<Record<PrStatus, boolean>> = {
    [PrStatus.None]: false,
    [PrStatus.AwaitingReview]: true,
    [PrStatus.ReviewStarted]: false,
    [PrStatus.ReReviewRequested]: true,
    [PrStatus.UnresolvedComments]: false,
    [PrStatus.ChangesRequested]: false,
    [PrStatus.Approved]: false,
    [PrStatus.OthersRequestedChanges]: false,
    [PrStatus.AwaitingOtherReviews]: false,
    [PrStatus.ChecksFailed]: false,
    [PrStatus.ReadyToMerge]: false,
    [PrStatus.Merged]: false,
    [PrStatus.Closed]: false,
};

/** Turns a review the viewer owes into `ReviewStarted` once the manual-review skill starts on it. */
export async function applyManualReviewStatus({
    prStatus,
    ...branch
}: Readonly<
    PullRequestBranch & {
        prStatus: PrStatus;
    }
>) {
    return owedReviewStatuses[prStatus] &&
        (await readManualReviewState(branch))?.status === ManualReviewStatus.Started
        ? PrStatus.ReviewStarted
        : prStatus;
}

/**
 * Closes the editor window the manual-review skill recorded for the branch's review, without
 * waiting for the skill to post the verdict.
 */
export async function closeReviewWindow(branch: Readonly<PullRequestBranch>) {
    const folder = (await readManualReviewEntry(branch))?.folder;
    if (closeEditorWindow && folder) {
        await closeEditorWindow({
            folder,
        });
    }
}

/**
 * Closes the editor window a review was read in once the skill posts its approval or change
 * request, whether the Review tab's buttons or a terminal asked for it. Verdicts already posted
 * when the server starts are left alone.
 */
export function startPostedVerdictWatch() {
    if (!closeEditorWindow) {
        return;
    }
    const closeWindow = closeEditorWindow;
    listenToManualReviewState(async (changedEntries) => {
        const folders = changedEntries.flatMap(({owner, repoName, entry}) => {
            if (entry.isPending || !entry.status || !postedVerdictStatuses[entry.status]) {
                return [];
            } else if (
                entry.folder &&
                doesPathContain({
                    potentialParentPath: manualReviewSkillDir,
                    potentialChildPath: entry.folder,
                })
            ) {
                return [
                    entry.folder,
                ];
            } else {
                return entry.prNumber
                    ? [
                          toReviewFolder({
                              owner,
                              repoName,
                              number: entry.prNumber,
                          }),
                      ]
                    : [];
            }
        });
        await Promise.all(
            folders.map(async (folder) => {
                try {
                    await closeWindow({
                        folder,
                    });
                } catch (error) {
                    log.warning(
                        `Failed to close the editor window for ${folder}: ${extractErrorMessage(error)}`,
                    );
                }
            }),
        );
    });
}

/**
 * Creates the folder a queued PR is reviewed in, if it's missing, and answers with it. Waits for
 * the first fetch when GitHub hasn't been queried yet, so a reloaded review URL still resolves.
 */
export async function resolveReviewFolder({
    owner,
    repoName,
    number,
    createFolder,
}: Readonly<
    PullRequestRef & {
        createFolder: boolean;
    }
>) {
    await Promise.all(
        [
            reviewQueue,
            assigneeQueue,
        ]
            .filter((queue) => !queue.cache.updatedAt)
            .map(async (queue) => await queue.update()),
    );
    const pullRequest = listReviewablePrs().find((pr) => {
        return pr.owner === owner && pr.repoName === repoName && pr.number === number;
    });
    if (!pullRequest?.branchName) {
        throw new Error(
            `${owner}/${repoName}#${number} isn't in your Review or Assignee queue, or you wrote it.`,
        );
    }
    const folder = toReviewFolder(pullRequest);
    if (
        !doesPathContain({
            potentialParentPath: manualReviewSkillDir,
            potentialChildPath: folder,
        })
    ) {
        throw new Error(
            `${owner}/${repoName}#${number} doesn't name a folder inside ${manualReviewSkillDir}.`,
        );
    }
    if (createFolder) {
        await mkdir(folder, {
            recursive: true,
        });
    }
    return {
        folder,
        pullRequest,
        review: await readManualReviewState(pullRequest),
    };
}

/**
 * Each `first:` multiplies into GitHub's GraphQL cost calculation, so these cover a large review
 * without paying for the pathological case.
 */
const maxReviewPrThreads = 100;
const maxReviewPrThreadComments = 50;
const maxReviewPrReviews = 100;

/**
 * `runGraphql` sends every variable as a string, and GitHub won't coerce a string into an `Int!`
 * variable, so the PR number is written into the document instead.
 */
function createReviewPrGraphql(number: number) {
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`"${number}" isn't a PR number.`);
    }
    return [
        'query($owner: String!, $name: String!) {',
        '  viewer { login avatarUrl }',
        '  repository(owner: $owner, name: $name) {',
        `    pullRequest(number: ${number}) {`,
        '      title titleHTML url bodyHTML headRefName',
        '      assignees(first: 10) { nodes { login } }',
        `      reviewThreads(first: ${maxReviewPrThreads}) {`,
        '        nodes {',
        '          id path line subjectType isResolved isOutdated viewerCanResolve viewerCanUnresolve',
        `          comments(first: ${maxReviewPrThreadComments}) { nodes { ${commentFields} diffHunk } }`,
        '        }',
        '      }',
        `      reviews(first: ${maxReviewPrReviews}) { nodes { ${reviewFields} } }`,
        `      timelineItems(last: ${maxReviewPrReviews}, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { id createdAt actor { login avatarUrl } requestedReviewer { ... on User { login } } } } }`,
        `      reviewRequests(first: ${maxReviewPrReviews}) { nodes { ${reviewRequestFields} } }`,
        `      latestOpinionatedReviews(first: ${maxReviewPrReviews}) { nodes { ${reviewFields} } }`,
        '    }',
        '  }',
        '}',
    ].join('\n');
}

const rawReviewRequestedEventShape = defineShape({
    id: '',
    createdAt: '',
    actor: nullableShape({
        login: '',
        avatarUrl: '',
    }),
    /** Has no `login` when a team was requested. */
    requestedReviewer: nullableShape({
        login: optionalShape(''),
    }),
});

/**
 * A `ReviewRequestedEvent`.
 *
 * Exported for tests.
 */
export type RawReviewRequestedEvent = typeof rawReviewRequestedEventShape.runtimeType;

const reviewPrPageShape = defineShape({
    viewer: {
        login: '',
        avatarUrl: '',
    },
    repository: nullableShape({
        pullRequest: nullableShape({
            title: '',
            titleHTML: '',
            url: '',
            bodyHTML: '',
            headRefName: '',
            assignees: {
                nodes: [
                    {
                        login: '',
                    },
                ],
            },
            reviewThreads: {
                nodes: [
                    defineShape({
                        ...rawThreadFields,
                        subjectType: enumShape(RawThreadSubjectType),
                    }),
                ],
            },
            reviews: {
                nodes: [
                    rawReviewShape,
                ],
            },
            timelineItems: {
                nodes: [
                    rawReviewRequestedEventShape,
                ],
            },
            reviewRequests: {
                nodes: [
                    rawReviewRequestShape,
                ],
            },
            latestOpinionatedReviews: {
                nodes: [
                    rawReviewShape,
                ],
            },
        }),
    }),
});

/** Exported for tests. */
export function toReviewers({
    requests,
    verdicts,
}: Readonly<{
    requests: ReadonlyArray<Readonly<GitHubReviewRequest>>;
    verdicts: ReadonlyArray<Readonly<GitHubReview>>;
}>) {
    const requested = requests.map((request) => {
        return {
            login: request.reviewer,
            avatarUrl: request.reviewerAvatarUrl,
            state: GitHubReviewState.Pending,
        };
    });
    const reviewed = verdicts
        .filter((verdict) => !requested.some((request) => request.login === verdict.author))
        .map((verdict) => {
            return {
                login: verdict.author,
                avatarUrl: verdict.authorAvatarUrl,
                state: verdict.state,
            };
        });
    return [
        ...requested,
        ...reviewed,
    ].toSorted((a, b) => a.login.localeCompare(b.login));
}

/** Exported for tests. */
export function toViewerReviewRequests({
    events,
    login,
}: Readonly<{
    events: ReadonlyArray<Readonly<RawReviewRequestedEvent>>;
    login: string;
}>) {
    return events
        .filter((event) => event.requestedReviewer?.login === login)
        .map((event, index) => {
            return {
                id: event.id,
                requester: event.actor?.login || '',
                requesterAvatarUrl: event.actor?.avatarUrl || '',
                createdAt: event.createdAt,
                isReRequest: index > 0,
            };
        });
}

async function fetchReviewPr({
    owner,
    repoName,
    number,
}: Readonly<PullRequestRef>): Promise<ReviewPr> {
    const page = assertWrapValidShape(
        await runGraphql(createReviewPrGraphql(number), {
            owner,
            name: repoName,
        }),
        reviewPrPageShape,
    );
    const pullRequest = page.repository?.pullRequest;
    if (!pullRequest) {
        throw new Error(`GitHub has no ${owner}/${repoName}#${number}.`);
    }
    const isViewerAssigned = pullRequest.assignees.nodes.some((assignee) => {
        return assignee.login === page.viewer.login;
    });
    return {
        reviewers: toReviewers({
            requests: toReviewRequests(pullRequest.reviewRequests.nodes),
            verdicts: pullRequest.latestOpinionatedReviews.nodes.map(toReview),
        }),
        viewer: {
            login: page.viewer.login,
            avatarUrl: page.viewer.avatarUrl,
        },
        title: pullRequest.title,
        titleHtml: pullRequest.titleHTML,
        url: pullRequest.url,
        bodyHtml: pullRequest.bodyHTML,
        branchName: pullRequest.headRefName,
        threads: pullRequest.reviewThreads.nodes
            .filter((rawThread) => {
                return (
                    (isViewerAssigned && !rawThread.isResolved) ||
                    rawThread.comments.nodes[0]?.author?.login === page.viewer.login
                );
            })
            .map((rawThread) => {
                const thread = toThread(rawThread);
                /** A file-level thread has no line to excerpt, and github.com shows it without one. */
                return rawThread.subjectType === RawThreadSubjectType.File
                    ? {
                          ...thread,
                          diffHunk: '',
                      }
                    : thread;
            }),
        reviews: pullRequest.reviews.nodes
            .filter((rawReview) => {
                return rawReview.author?.login === page.viewer.login;
            })
            .map(toReview)
            .filter((review) => {
                /**
                 * Every inline comment or reply posted on its own lands in a body-less "commented"
                 * review, which would only repeat the thread it belongs to. An unsubmitted review
                 * isn't one yet.
                 */
                return (
                    review.state !== GitHubReviewState.Pending &&
                    (!!review.body || review.state !== GitHubReviewState.Commented)
                );
            }),
        reviewRequests: toViewerReviewRequests({
            events: pullRequest.timelineItems.nodes,
            login: page.viewer.login,
        }),
        fetchedAt: Date.now(),
    };
}

/**
 * Each branch's latest PR fetch, by `owner/repo>branch`, shared by the Build and Review tabs.
 * In-flight fetches are shared.
 */
const reviewPrCache = new Map<
    string,
    {
        number: number;
        fetching: Promise<ReviewPr>;
    }
>();

/**
 * Answers from the server's cache, fetching from GitHub only for a PR it hasn't seen or when
 * `forceRefresh` is set. A failed refresh keeps the previous copy cached.
 */
export async function readReviewPr({
    owner,
    repoName,
    number,
    branchName,
    forceRefresh,
}: Readonly<
    PullRequestRef & {
        branchName: string;
        forceRefresh: boolean;
    }
>) {
    const cacheKey = `${owner}/${repoName}>${branchName}`;
    const cached = reviewPrCache.get(cacheKey);
    if (cached?.number === number && !forceRefresh) {
        return await cached.fetching;
    }
    const entry = {
        number,
        fetching: fetchReviewPr({
            owner,
            repoName,
            number,
        }),
    };
    reviewPrCache.set(cacheKey, entry);
    try {
        return await entry.fetching;
    } catch (error) {
        if (reviewPrCache.get(cacheKey) === entry) {
            if (cached) {
                reviewPrCache.set(cacheKey, cached);
            } else {
                reviewPrCache.delete(cacheKey);
            }
        }
        throw error;
    }
}

/** Recursive, so the return type can't be inferred. */
async function fetchSearchPages({
    searchQuery,
    afterCursor,
    pageIndex,
}: Readonly<{
    searchQuery: string;
    afterCursor: string | undefined;
    pageIndex: number;
}>): Promise<(typeof searchPageShape.runtimeType)[]> {
    const page = assertWrapValidShape(
        await runGraphql(searchGraphql, {
            searchQuery,
            ...(afterCursor
                ? {
                      afterCursor,
                  }
                : {}),
        }),
        searchPageShape,
    );
    return [
        page,
        ...(page.search.pageInfo.hasNextPage &&
        page.search.pageInfo.endCursor &&
        pageIndex + 1 < maxSearchPages
            ? await fetchSearchPages({
                  searchQuery,
                  afterCursor: page.search.pageInfo.endCursor,
                  pageIndex: pageIndex + 1,
              })
            : []),
    ];
}

/**
 * Port of review-vir's Reviewer list ordering (`@review-vir/adapter-core`
 * `organize-pull-requests.ts` and `@review-vir/github-adapter` `parse-github-data.ts`). The search
 * query already did its filtering, except that a PR whose review by the viewer was dismissed
 * without a new request isn't listed here although review-vir lists it. Change it alongside
 * review-vir, or the two lists drift.
 */
export function organizeReviewQueue({
    prs,
    login,
    trustedBotLogins,
}: Readonly<{
    prs: ReadonlyArray<Readonly<RawReviewPr>>;
    login: string;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    return organizePrs({
        prs,
        login,
        trustedBotLogins,
        sortNumber(pr) {
            return reviewerSortNumber(pr, login);
        },
    });
}

/**
 * Port of review-vir's Assignee list ordering, from the same files as {@link organizeReviewQueue}.
 * Review-vir never counts an assigned PR as needing the viewer's review, so of its sort bonuses
 * only the draft one applies.
 */
export function organizeAssigneeQueue({
    prs,
    login,
    trustedBotLogins,
}: Readonly<{
    prs: ReadonlyArray<Readonly<RawReviewPr>>;
    login: string;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    return organizePrs({
        prs,
        login,
        trustedBotLogins,
        sortNumber(pr) {
            return pr.isDraft ? 0 : 10_000;
        },
    });
}

/** PR URLs already logged for an unsafe branch name, so each is only logged once. */
const loggedUnsafeBranchPrUrls = new Set<string>();

function organizePrs({
    prs,
    login,
    trustedBotLogins,
    sortNumber,
}: Readonly<{
    prs: ReadonlyArray<Readonly<RawReviewPr>>;
    login: string;
    trustedBotLogins: ReadonlyArray<string>;
    sortNumber: (pr: Readonly<RawReviewPr>) => number;
}>): ReviewQueuePr[] {
    const safePrs = prs.filter((pr) => {
        const branchName = pr.headRef?.name || '';
        if (!branchName || isSafeBranchName(branchName)) {
            return true;
        }
        if (!loggedUnsafeBranchPrUrls.has(pr.url)) {
            loggedUnsafeBranchPrUrls.add(pr.url);
            log.warning(
                `Leaving ${pr.url} out of the queue: unsafe branch name ${JSON.stringify(branchName)}.`,
            );
        }
        return false;
    });
    const owners = removeDuplicates(safePrs.map((pr) => pr.baseRepository.owner.login)).toSorted();

    return owners.flatMap((owner) => {
        return flattenDepthFirst(
            chainPrs({
                prs: safePrs.filter((pr) => pr.baseRepository.owner.login === owner),
                sortNumber,
            }),
        ).map(({pr, chainDepth}): ReviewQueuePr => {
            return {
                owner,
                repoName: pr.baseRepository.name,
                number: pr.number,
                title: pr.title,
                titleHtml: pr.titleHTML,
                url: pr.url,
                bodyHtml: pr.bodyHTML,
                branchName: pr.headRef?.name || '',
                headSha: pr.headRefOid,
                isDraft: pr.isDraft,
                chainDepth,
                prStatus: toOpenPrStatus(pr),
                isViewerAuthor: !!login && pr.author?.login === login,
                isAwaitingViewerReview: !!pr.viewerLatestReviewRequest,
                hasViewerReviewed: latestReviewTime(pr) != undefined,
                panes: {
                    [PaneKind.Ai]: PaneStatus.None,
                    [PaneKind.Shell]: PaneStatus.None,
                },
                author: pr.author?.login || '',
                authorAvatarUrl: pr.author?.avatarUrl || '',
                isAuthorTrusted:
                    collaboratorAssociations[pr.authorAssociation] ||
                    isTrustedBot({
                        author: pr.author,
                        trustedBotLogins,
                    }),
                assignees: assigneesOf(pr).map((user) => {
                    return {
                        login: user.login,
                        avatarUrl: user.avatarUrl,
                    };
                }),
            };
        });
    });
}

/** Review-vir counts the author as the assignee when a PR has none. */
function assigneesOf(pr: Readonly<RawReviewPr>) {
    return pr.assignees.nodes.length
        ? pr.assignees.nodes
        : pr.author
          ? [
                pr.author,
            ]
          : [];
}

/** Review-vir's `parseDescriptionUsers`, which reads `bodyText`, not the markdown body. */
function parseDescriptionUsers({
    bodyText,
    triggerText,
}: Readonly<{
    bodyText: string;
    triggerText: string;
}>) {
    const match = new RegExp(String.raw`${triggerText}s?\W+((?:@[^@]+)+)(?:\n\n|$|\n#)`, 'i').exec(
        bodyText,
    )?.[1];
    const restrictedMatch = match ? /((?:@[\w-]+[^\w@]*)+)/.exec(match)?.[1] : undefined;
    return Array.from(restrictedMatch?.matchAll(/@[\w-]+/g) || []).map((tag) => tag[0].slice(1));
}

function reviewerSortNumber(pr: Readonly<RawReviewPr>, login: string) {
    const isPrimaryReviewer = parseDescriptionUsers({
        bodyText: pr.bodyText,
        triggerText: 'primary reviewer',
    }).includes(login);
    const isCodeOwner = (
        parseInsertedCodeOwners(pr.body) ??
        parseDescriptionUsers({
            bodyText: pr.bodyText,
            triggerText: 'code owner',
        })
    ).includes(login);

    return (isPrimaryReviewer ? 100 : 0) + (isCodeOwner ? 10 : 0);
}

function readyForReviewTime(pr: Readonly<RawReviewPr>) {
    return Date.parse(pr.timelineItems.nodes[0]?.createdAt || pr.createdAt);
}

function latestReviewTime(pr: Readonly<RawReviewPr>) {
    return pr.viewerLatestReview?.submittedAt
        ? Date.parse(pr.viewerLatestReview.submittedAt)
        : undefined;
}

/** PRs the viewer never reviewed sort first, then the ones they reviewed longest ago. */
function compareLatestReviews({
    a,
    b,
}: Readonly<{
    a: Readonly<RawReviewPr>;
    b: Readonly<RawReviewPr>;
}>) {
    const aReview = latestReviewTime(a);
    const bReview = latestReviewTime(b);
    if (aReview == undefined || bReview == undefined) {
        return (aReview == undefined ? 0 : 1) - (bReview == undefined ? 0 : 1);
    }
    return aReview - bReview;
}

function headKey(pr: Readonly<RawReviewPr>) {
    return [
        pr.headRepository?.owner.login,
        pr.headRepository?.name,
        pr.headRef?.name,
    ].join('/');
}

function baseKey(pr: Readonly<RawReviewPr>) {
    return [
        pr.baseRepository.owner.login,
        pr.baseRepository.name,
        pr.baseRef?.name,
    ].join('/');
}

/**
 * Review-vir's `createChainedPullRequests`: a PR whose base branch is another listed PR's head
 * nests under it. A PR is taken off the top level whenever any listed PR shares its base as a head,
 * even when that PR targets its own head and so can't be a parent, which hides the child entirely.
 * That matches review-vir, which drops the same PRs.
 */
function chainPrs({
    prs,
    sortNumber,
}: Readonly<{
    prs: ReadonlyArray<Readonly<RawReviewPr>>;
    sortNumber: (pr: Readonly<RawReviewPr>) => number;
}>) {
    const headKeys = prs.map(headKey);

    /**
     * Two PRs from the same head branch can each be the other's parent through a third PR, so a PR
     * already in the chain above isn't nested again.
     *
     * Recursive, so the return type can't be inferred.
     */
    function toChained(pr: Readonly<RawReviewPr>, ancestorUrls: ReadonlyArray<string>): ChainedPr {
        const chainUrls = [
            ...ancestorUrls,
            pr.url,
        ];
        return {
            pr,
            children:
                pr.headRef?.name === pr.baseRef?.name
                    ? []
                    : prs
                          .filter((child) => {
                              return (
                                  baseKey(child) === headKey(pr) && !chainUrls.includes(child.url)
                              );
                          })
                          .map((child) => toChained(child, chainUrls)),
        };
    }

    return prs
        .filter((pr) => !headKeys.includes(baseKey(pr)))
        .map((pr) => toChained(pr, []))
        .sort((a, b) => {
            const reviewOrder = compareLatestReviews({
                a: a.pr,
                b: b.pr,
            });
            if (reviewOrder) {
                return reviewOrder;
            }
            const aTime = readyForReviewTime(a.pr);
            const bTime = readyForReviewTime(b.pr);
            const bTimeOrder = bTime > aTime ? 1 : aTime > bTime ? -1 : 0;
            return sortNumber(b.pr) - (sortNumber(a.pr) + bTimeOrder);
        });
}

/** Recursive, so the return type can't be inferred. */
function flattenDepthFirst(
    chained: ReadonlyArray<ChainedPr>,
    chainDepth = 0,
): {
    pr: Readonly<RawReviewPr>;
    chainDepth: number;
}[] {
    return chained.flatMap((entry) => {
        return [
            {
                pr: entry.pr,
                chainDepth,
            },
            ...flattenDepthFirst(entry.children, chainDepth + 1),
        ];
    });
}
