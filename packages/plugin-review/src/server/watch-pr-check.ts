import {
    collaboratorAssociations,
    failedCheckResults,
    ForgeType,
    GitHubReaction,
    isTrustedBot,
    mergeableMergeStates,
    RawActorType,
    RawAuthorAssociation,
    RawCheckResult,
    RawCheckStatus,
    RawMergeable,
    RawMergeState,
    RawPrState,
    RawReviewDecision,
    RawReviewState,
    runningCheckStatuses,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    getObjectTypedEntries,
    getObjectTypedKeys,
    omitObjectKeys,
    removeDuplicates,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {runGhCommand} from 'agent-storm-util';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {createHash} from 'node:crypto';
import {
    assertWrapValidShape,
    defineShape,
    enumShape,
    exactShape,
    nullableShape,
    partialShape,
    recordShape,
    unionShape,
} from 'object-shape-tester';
import {
    mentionsAny,
    prStatusFields,
    rawPrStatusFields,
    runGraphql,
    shareFolderPrStatus,
} from './github-pr.js';
import {readReviewHost} from './review-host.js';

/** Gating jobs that only go green once everything else does, so they never count as failing work. */
const gatingCheckNames: ReadonlyArray<string> = [
    'Check Review Status',
    'All Tests Done',
    'PR Review',
];

const rawLoginShape = defineShape(
    nullableShape({
        login: '',
    }),
);

/** An empty string for a field the check has no value for, as `gh pr view --json` prints it. */
const rawStatusCheckShape = defineShape(
    partialShape({
        name: '',
        context: '',
        workflowName: '',
        status: unionShape(enumShape(RawCheckStatus), exactShape('')),
        conclusion: unionShape(enumShape(RawCheckResult), exactShape('')),
        state: unionShape(enumShape(RawCheckResult), exactShape('')),
        startedAt: '',
        createdAt: '',
        /** An Actions job's is `…/actions/runs/<run id>/job/<job id>`. */
        detailsUrl: '',
    }),
);

export type RawStatusCheck = typeof rawStatusCheckShape.runtimeType;

const rawRequestedReviewerShape = defineShape(
    partialShape({
        login: '',
        name: '',
        slug: '',
    }),
);

/**
 * A PR in the flattened form `gh pr view --json` prints, which is what {@link classifyPrCheck}
 * reads.
 */
const rawPrViewFields = {
    number: 0,
    url: '',
    title: '',
    body: '',
    headRefName: '',
    headRefOid: '',
    baseRefName: '',
    baseRefOid: '',
    author: rawLoginShape,
    isDraft: false,
    state: enumShape(RawPrState),
    /** Empty or null when the repo doesn't require a review. */
    reviewDecision: nullableShape(unionShape(enumShape(RawReviewDecision), exactShape(''))),
    mergeStateStatus: unionShape(enumShape(RawMergeState), exactShape('')),
    mergeable: unionShape(enumShape(RawMergeable), exactShape('')),
    assignees: [
        rawLoginShape,
    ],
    latestReviews: [
        {
            author: rawLoginShape,
            authorAssociation: enumShape(RawAuthorAssociation),
            state: enumShape(RawReviewState),
            submittedAt: '',
        },
    ],
    /** Every review, oldest first. Unlike `latestReviews`, a later comment hides no verdict here. */
    reviews: [
        {
            author: rawLoginShape,
            state: enumShape(RawReviewState),
            submittedAt: nullableShape(''),
            commit: nullableShape({
                oid: '',
            }),
        },
    ],
    reviewRequests: [
        rawRequestedReviewerShape,
    ],
    statusCheckRollup: nullableShape([
        rawStatusCheckShape,
    ]),
};

export const rawPrViewShape = defineShape(rawPrViewFields);

export type RawPrView = typeof rawPrViewShape.runtimeType;

const rawThreadCommentShape = defineShape({
    /** Null once the author deletes their account. */
    author: nullableShape({
        __typename: enumShape(RawActorType),
        login: '',
    }),
    authorAssociation: enumShape(RawAuthorAssociation),
    body: '',
    createdAt: '',
    reactionGroups: nullableShape([
        {
            content: enumShape(GitHubReaction),
            viewerHasReacted: false,
        },
    ]),
});

type RawThreadComment = typeof rawThreadCommentShape.runtimeType;

const rawReviewThreadShape = defineShape({
    id: '',
    isResolved: false,
    comments: {
        nodes: [
            rawThreadCommentShape,
        ],
    },
});

export type RawReviewThread = typeof rawReviewThreadShape.runtimeType;

/** A status check rollup entry: an Actions job's `CheckRun` or a third-party `StatusContext`. */
const rawCheckContextShape = defineShape(
    partialShape({
        name: '',
        /** Null until the run finishes. */
        conclusion: nullableShape(enumShape(RawCheckResult)),
        status: nullableShape(enumShape(RawCheckStatus)),
        startedAt: nullableShape(''),
        detailsUrl: nullableShape(''),
        checkSuite: nullableShape({
            workflowRun: nullableShape({
                workflow: {
                    name: '',
                },
            }),
        }),
        context: '',
        state: enumShape(RawCheckResult),
        createdAt: '',
    }),
);

const rawCheckContextPageShape = defineShape({
    pageInfo: {
        hasNextPage: false,
        endCursor: nullableShape(''),
    },
    nodes: [
        rawCheckContextShape,
    ],
});

const rawWatchedPrShape = defineShape({
    /**
     * `statusCheckRollup` is never filled here. The rollup is read from `commits` instead.
     * `baseRefOid` is read from `baseRef` instead.
     */
    ...omitObjectKeys(rawPrViewFields, ['baseRefOid']),
    ...rawPrStatusFields,
    author: nullableShape({
        __typename: enumShape(RawActorType),
        login: '',
    }),
    assignees: {
        nodes: rawPrViewFields.assignees,
    },
    latestReviews: {
        nodes: rawPrViewFields.latestReviews,
    },
    reviews: {
        nodes: rawPrViewFields.reviews,
    },
    reviewRequests: {
        nodes: [
            {
                requestedReviewer: nullableShape(rawRequestedReviewerShape),
            },
        ],
    },
    commits: {
        nodes: [
            {
                commit: {
                    oid: '',
                    statusCheckRollup: nullableShape({
                        state: enumShape(RawCheckResult),
                        contexts: rawCheckContextPageShape,
                    }),
                },
            },
        ],
    },
    /** The base branch's current tip. The PR's own `baseRefOid` stays where the PR was opened. */
    baseRef: nullableShape({
        target: nullableShape({
            oid: '',
        }),
    }),
    /** Null once the fork it came from is deleted. */
    headRepository: nullableShape({
        nameWithOwner: '',
    }),
    reviewThreads: {
        nodes: [
            rawReviewThreadShape,
        ],
    },
});

const watchedPrResponseShape = defineShape({
    repository: nullableShape({
        open: {
            nodes: [
                rawWatchedPrShape,
            ],
        },
        closed: {
            nodes: [
                rawWatchedPrShape,
            ],
        },
    }),
});

const moreCheckContextsResponseShape = defineShape({
    repository: nullableShape({
        object: nullableShape({
            statusCheckRollup: nullableShape({
                contexts: rawCheckContextPageShape,
            }),
        }),
    }),
});

export enum ThreadStatus {
    Actionable = 'actionable',
    /** A human answered a thread the AI handed to them, so it's work again. */
    HumanReplied = 'human-replied',
    /** The AI handed this thread to a human and nobody has answered yet. */
    AwaitingHuman = 'awaiting-human',
    NeedsViewerThumbsUp = 'needs-viewer-thumbs-up',
}

/** How each thread status counts toward the PR's open work. */
const threadStatusRoles: Readonly<
    Record<
        ThreadStatus,
        {
            isWork: boolean;
            awaitsViewerThumbsUp: boolean;
        }
    >
> = {
    [ThreadStatus.Actionable]: {
        isWork: true,
        awaitsViewerThumbsUp: false,
    },
    [ThreadStatus.HumanReplied]: {
        isWork: true,
        awaitsViewerThumbsUp: false,
    },
    [ThreadStatus.AwaitingHuman]: {
        isWork: false,
        awaitsViewerThumbsUp: false,
    },
    [ThreadStatus.NeedsViewerThumbsUp]: {
        isWork: false,
        awaitsViewerThumbsUp: true,
    },
};

export enum PrNeed {
    MergeConflict = 'merge conflict',
    Comments = 'comments',
    Tests = 'tests',
    ReRequestReview = 're-request review',
    MergeBlocked = 'merge blocked',
}

function toLogin(value: Readonly<{login: string}> | null | undefined) {
    return value?.login || '';
}

function isAiBody(body: string) {
    return body.startsWith('AI: ');
}

/**
 * Marks the file comment that says why watch mode re-requested a review. Only the reviewer resolves
 * it, so it is never work for a pass and never holds up the merge.
 */
export const reviewRequestNoteMarker = '<!-- watch-mode-review-request -->';

/** Written by someone GitHub lists as having access to the repo, or by a trusted review bot. */
function isTrustedComment({
    comment,
    trustedBotLogins,
}: Readonly<{
    comment: Readonly<RawThreadComment>;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    return (
        collaboratorAssociations[comment.authorAssociation] ||
        isTrustedBot({
            author: comment.author,
            trustedBotLogins,
        })
    );
}

/** A collaborator writing as themselves, not through the AI. */
function isHumanComment(comment: Readonly<RawThreadComment>) {
    return (
        comment.author?.__typename === RawActorType.User &&
        collaboratorAssociations[comment.authorAssociation] &&
        !isAiBody(comment.body)
    );
}

function hasViewerThumbsUp(comment: Readonly<RawThreadComment>) {
    return !!comment.reactionGroups?.some((group) => {
        return group.content === GitHubReaction.ThumbsUp && group.viewerHasReacted;
    });
}

/**
 * Only comments from repo collaborators and trusted review bots can make a thread work, so a
 * stranger's comment on a public repo never steers the AI. Anything else waits for the viewer's 👍.
 * A hand-off is an `AI: ` reply that @-mentions an assignee, or any `AI: ` reply in a thread an
 * assignee opened, since only the assignee resolves their own threads: the thread waits on a human
 * until a collaborator replies after it.
 */
export function classifyThread({
    thread,
    assignees,
    trustedBotLogins,
}: Readonly<{
    thread: Readonly<RawReviewThread>;
    assignees: ReadonlyArray<string>;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    const comments = thread.comments.nodes;
    const first = comments[0];
    const isAssigneeThread =
        !!first && !isAiBody(first.body) && assignees.includes(toLogin(first.author));
    const lastHandOffIndex = comments.findLastIndex((comment) => {
        return (
            isTrustedComment({
                comment,
                trustedBotLogins,
            }) &&
            isAiBody(comment.body) &&
            (isAssigneeThread ||
                mentionsAny({
                    body: comment.body,
                    logins: assignees,
                }))
        );
    });
    if (lastHandOffIndex >= 0) {
        return comments.slice(lastHandOffIndex + 1).some(isHumanComment)
            ? ThreadStatus.HumanReplied
            : ThreadStatus.AwaitingHuman;
    } else if (
        first &&
        (hasViewerThumbsUp(first) ||
            (isTrustedComment({
                comment: first,
                trustedBotLogins,
            }) &&
                (isTrustedBot({
                    author: first.author,
                    trustedBotLogins,
                }) ||
                    isAiBody(first.body) ||
                    first.body.includes('<!-- do-later-review-comment -->') ||
                    assignees.includes(toLogin(first.author)))))
    ) {
        return ThreadStatus.Actionable;
    } else {
        return ThreadStatus.NeedsViewerThumbsUp;
    }
}

function checkName(statusCheck: Readonly<RawStatusCheck>) {
    return statusCheck.name || statusCheck.context || '';
}

/** Missing times sort last, so a run that has not started counts as the newest one. */
function checkStartedAt(statusCheck: Readonly<RawStatusCheck>) {
    return statusCheck.startedAt || statusCheck.createdAt || '9999';
}

function workflowRunId(statusCheck: Readonly<RawStatusCheck>) {
    const runId = /\/actions\/runs\/(\d+)/.exec(statusCheck.detailsUrl || '')?.[1];
    return runId ? Number(runId) : undefined;
}

/**
 * A newer workflow run's job can start before an older run's job does, which made a stale pass look
 * like the latest run while GitHub blocked the merge on the newer failure. GitHub hands out run ids
 * in creation order, so those decide. A re-run attempt keeps its run id, so start time breaks
 * ties.
 */
function isNewerCheck({
    statusCheck,
    than,
}: Readonly<{
    statusCheck: Readonly<RawStatusCheck>;
    than: Readonly<RawStatusCheck>;
}>) {
    const runId = workflowRunId(statusCheck);
    const otherRunId = workflowRunId(than);
    return runId == undefined || otherRunId == undefined || runId === otherRunId
        ? checkStartedAt(statusCheck) > checkStartedAt(than)
        : runId > otherRunId;
}

/**
 * A `CheckRun` reports `conclusion` and a `StatusContext` reports `state`. A cancelled run is
 * usually one a newer run superseded and has nothing for a pass to fix; when it does block the
 * merge, the PR reads as merge blocked instead.
 */
function isFailed(statusCheck: Readonly<RawStatusCheck>) {
    const result = statusCheck.conclusion || statusCheck.state;
    return !!result && result !== RawCheckResult.Cancelled && failedCheckResults[result];
}

function isStatusRunning(status: RawStatusCheck['status']) {
    return !!status && runningCheckStatuses[status];
}

function isRunning(statusCheck: Readonly<RawStatusCheck>) {
    return (
        isStatusRunning(statusCheck.status) ||
        (statusCheck.conclusion || statusCheck.state) === RawCheckResult.Pending
    );
}

/** A rerun leaves the superseded run in the rollup, so only the latest run of each check counts. */
function latestChecks(rollup: ReadonlyArray<Readonly<RawStatusCheck>>) {
    return getLatestByName(rollup).filter((statusCheck) => !!checkName(statusCheck));
}

function getLatestByName(rollup: ReadonlyArray<Readonly<RawStatusCheck>>) {
    return removeDuplicates(rollup.map(checkName)).map((name) => {
        return rollup
            .filter((statusCheck) => checkName(statusCheck) === name)
            .reduce((latest, statusCheck) => {
                return isNewerCheck({
                    statusCheck,
                    than: latest,
                })
                    ? statusCheck
                    : latest;
            });
    });
}

export type PrCheck = ReturnType<typeof classifyPrCheck>;

/** Pure half of {@link fetchPrCheck}: everything `check-pr.sh` derives from GitHub's answers. */
export function classifyPrCheck({
    pr,
    threads,
    viewerLogin,
    checkedAt,
    trustedBotLogins,
}: Readonly<{
    pr: Readonly<RawPrView>;
    threads: ReadonlyArray<Readonly<RawReviewThread>>;
    viewerLogin: string;
    checkedAt: string;
    trustedBotLogins: ReadonlyArray<string>;
}>) {
    const assignees = pr.assignees.map(toLogin).filter(check.isTruthy);
    const authorLogin = toLogin(pr.author);
    const unresolvedThreads = threads
        .filter((thread) => {
            return (
                !thread.isResolved &&
                !thread.comments.nodes[0]?.body.includes(reviewRequestNoteMarker)
            );
        })
        .map((thread) => {
            return {
                id: thread.id,
                status: classifyThread({
                    thread,
                    assignees,
                    trustedBotLogins,
                }),
                openedBy: toLogin(thread.comments.nodes[0]?.author) || 'unknown',
                participants: removeDuplicates(
                    thread.comments.nodes.map((comment) => toLogin(comment.author)),
                ).filter(check.isTruthy),
            };
        });
    const actionableCount = unresolvedThreads.filter((thread) => {
        return threadStatusRoles[thread.status].isWork;
    }).length;
    const thumbsUpWaitCount = unresolvedThreads.filter((thread) => {
        return threadStatusRoles[thread.status].awaitsViewerThumbsUp;
    }).length;

    const rollup = pr.statusCheckRollup || [];
    const runningWorkflowChecks = rollup.filter((statusCheck) => {
        return !!statusCheck.workflowName && isStatusRunning(statusCheck.status);
    });
    const latest = latestChecks(rollup);
    const visibleChecks = latest.filter((statusCheck) => {
        return !gatingCheckNames.includes(checkName(statusCheck));
    });
    const gatingChecks = latest.filter((statusCheck) => {
        return gatingCheckNames.includes(checkName(statusCheck));
    });
    /**
     * A workflow run creates its later jobs only once earlier ones finish, so while a newer run of
     * the same workflow is still going, an older failure of a job it hasn't created yet is stale.
     */
    const failingChecks = removeDuplicates(
        visibleChecks
            .filter((statusCheck) => {
                return (
                    !statusCheck.workflowName ||
                    !runningWorkflowChecks.some((running) => {
                        return (
                            running.workflowName === statusCheck.workflowName &&
                            (running.startedAt || '9999') > (statusCheck.startedAt || '')
                        );
                    })
                );
            })
            .filter(isFailed)
            .map(checkName),
    ).toSorted();
    const pendingCount = visibleChecks.filter(isRunning).length;
    const gatingPendingCount = gatingChecks.filter(isRunning).length;
    const gatingFailingCount = gatingChecks.filter(isFailed).length;

    const mergeState = pr.mergeStateStatus || RawMergeState.Unknown;
    const mergeable = pr.mergeable || RawMergeable.Unknown;
    const reviewDecision = pr.reviewDecision || 'NONE';
    const requestedReviewers = pr.reviewRequests
        .map((request) => request.login || request.name || request.slug || '')
        .filter(check.isTruthy);
    const collaboratorReviews = pr.latestReviews.filter((review) => {
        return collaboratorAssociations[review.authorAssociation];
    });
    const openThreadAuthors = unresolvedThreads.map((thread) => thread.openedBy);
    /**
     * A changes-requested review whose threads are all resolved has been answered, so it belongs
     * back in the reviewer's queue whether or not a pass pushed anything for it.
     */
    const viewerVerdict = pr.reviews.findLast((review) => {
        return (
            toLogin(review.author) === viewerLogin &&
            [
                RawReviewState.Approved,
                RawReviewState.ChangesRequested,
            ].includes(review.state)
        );
    });
    const reReviewLogins = removeDuplicates(
        collaboratorReviews
            .filter((review) => review.state === RawReviewState.ChangesRequested)
            .map((review) => toLogin(review.author))
            .filter((login) => {
                return (
                    !!login &&
                    !openThreadAuthors.includes(login) &&
                    !requestedReviewers.includes(login) &&
                    login !== authorLogin
                );
            }),
    );
    const isConflicted =
        mergeable === RawMergeable.Conflicting || mergeState === RawMergeState.Dirty;
    const baseNeeds = [
        isConflicted && PrNeed.MergeConflict,
        actionableCount > 0 && PrNeed.Comments,
        failingChecks.length > 0 && PrNeed.Tests,
        reReviewLogins.length > 0 && PrNeed.ReRequestReview,
    ].filter(check.isTruthy);
    const isNothingOpen =
        !baseNeeds.length &&
        !pr.isDraft &&
        !unresolvedThreads.length &&
        !pendingCount &&
        (!pr.reviewDecision || pr.reviewDecision === RawReviewDecision.Approved);
    /**
     * GitHub still refusing the merge once every visible check passed, the gating checks finished,
     * and review is satisfied means something this check can't see is failing. A failed gate with a
     * review request still open is that reviewer not having approved yet: a human wait.
     */
    const isBlockedWithNothingOpen =
        isNothingOpen && !gatingPendingCount && mergeState === RawMergeState.Blocked;
    const isAwaitingRequestedReview =
        isBlockedWithNothingOpen && gatingFailingCount > 0 && requestedReviewers.length > 0;
    const needs = [
        ...baseNeeds,
        isBlockedWithNothingOpen && !isAwaitingRequestedReview && PrNeed.MergeBlocked,
    ].filter(check.isTruthy);
    const humanActivityAt = [
        ...collaboratorReviews.map((review) => review.submittedAt),
        ...threads.flatMap((thread) => {
            return thread.comments.nodes.filter(isHumanComment).map((comment) => comment.createdAt);
        }),
    ]
        .filter(check.isTruthy)
        .reduce((latestAt, at) => (at > latestAt ? at : latestAt), '');

    return {
        number: pr.number,
        url: pr.url,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        checkedAt,
        branch: pr.headRefName,
        baseBranch: pr.baseRefName,
        baseSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        authorLogin,
        isDraft: pr.isDraft,
        assignees,
        reviewDecision,
        mergeState,
        mergeable,
        isConflicted,
        reviews: pr.latestReviews.map((review) => {
            return {
                login: toLogin(review.author),
                state: review.state,
            };
        }),
        requestedReviewers,
        unresolvedThreads,
        actionableCount,
        pendingCount,
        gatingPendingCount,
        failingChecks,
        reReviewLogins,
        /** The `reReviewLogins` who opened no review thread, so left nothing that can be resolved. */
        summaryOnlyReReviewLogins: reReviewLogins.filter((login) => {
            return !threads.some((thread) => toLogin(thread.comments.nodes[0]?.author) === login);
        }),
        needs,
        isReadyToMerge: isNothingOpen && mergeableMergeStates[mergeState],
        isAwaitingRequestedReview,
        isAwaitingViewerReview:
            isAwaitingRequestedReview && requestedReviewers.includes(viewerLogin),
        /** ISO time of the viewer's latest approval or change request, empty when there is none. */
        viewerVerdictAt: viewerVerdict?.submittedAt || '',
        /** The commit the viewer's latest approval or change request was on. */
        viewerVerdictSha: viewerVerdict?.commit?.oid || '',
        /** Logins whose latest approval, change request, or dismissal is a change request. */
        changesRequestedBy: removeDuplicates(
            pr.reviews.map((review) => toLogin(review.author)).filter(check.isTruthy),
        ).filter((login) => {
            return (
                pr.reviews.findLast((review) => {
                    return (
                        toLogin(review.author) === login &&
                        [
                            RawReviewState.Approved,
                            RawReviewState.ChangesRequested,
                            RawReviewState.Dismissed,
                        ].includes(review.state)
                    );
                })?.state === RawReviewState.ChangesRequested
            );
        }),
        isBlockedOnHuman: thumbsUpWaitCount > 0 || isAwaitingRequestedReview,
        /** A review thread waits on a human's answer or the viewer's 👍. */
        isAwaitingThreadAnswer: thumbsUpWaitCount > 0,
        /** ISO time of the latest collaborator review or comment, empty when there is none. */
        humanActivityAt,
    };
}

/** The same report `check-pr.sh` prints, which is what the AI's pass instructions describe. */
export function formatPrCheck(prCheck: Readonly<PrCheck>) {
    return [
        `pr: ${prCheck.number}`,
        `state: ${prCheck.state}`,
        `checked at: ${prCheck.checkedAt}`,
        `url: ${prCheck.url}`,
        `branch: ${prCheck.branch}`,
        `head sha: ${prCheck.headSha}`,
        `draft: ${prCheck.isDraft ? 'yes' : 'no'}`,
        `assignees: ${prCheck.assignees.join(',')}`,
        `review decision: ${prCheck.reviewDecision}`,
        `merge state: ${prCheck.mergeState}`,
        `mergeable: ${prCheck.mergeable}`,
        `merge conflict: ${prCheck.isConflicted ? 'yes' : 'no'}`,
        ...prCheck.reviews.map((review) => `review: ${review.login} ${review.state}`),
        ...prCheck.requestedReviewers.map((login) => `review requested: ${login}`),
        `unresolved threads: ${prCheck.unresolvedThreads.length}`,
        `actionable threads: ${prCheck.actionableCount}`,
        ...prCheck.unresolvedThreads.map((thread) => {
            return [
                `unresolved thread: ${thread.id} ${thread.status}`,
                `opened by ${thread.openedBy}`,
                `participants: ${thread.participants.join(',')}`,
            ].join(', ');
        }),
        `pending checks: ${prCheck.pendingCount}`,
        `pending gating checks: ${prCheck.gatingPendingCount}`,
        `failing checks: ${prCheck.failingChecks.length}`,
        ...prCheck.failingChecks.map((name) => `failing check: ${name}`),
        ...prCheck.needs.map((need) => `needs: ${need}`),
        `ready to merge: ${prCheck.isReadyToMerge ? 'yes' : 'no'}`,
        `blocked on human feedback: ${prCheck.isBlockedOnHuman ? 'yes' : 'no'}`,
    ].join('\n');
}

const checkContextFields = [
    'pageInfo { hasNextPage endCursor }',
    'nodes {',
    '  ... on CheckRun { name conclusion status startedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }',
    '  ... on StatusContext { context state createdAt }',
    '}',
].join('\n');

/**
 * Everything one watch mode check reads about the branch's PR, in one request. Each connection
 * holds at most one page, so a PR past that many reviews or threads is read only in part.
 */
const watchedPrQuery = [
    'query($owner: String!, $repo: String!, $branch: String!) {',
    '  repository(owner: $owner, name: $repo) {',
    '    open: pullRequests(headRefName: $branch, states: [OPEN], first: 3, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...WatchedPr } }',
    '    closed: pullRequests(headRefName: $branch, states: [MERGED, CLOSED], first: 3, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...WatchedPr } }',
    '  }',
    '}',
    'fragment WatchedPr on PullRequest {',
    '  number url title body headRefName headRefOid baseRefName baseRef { target { oid } } isDraft state reviewDecision mergeStateStatus mergeable',
    `  ${prStatusFields}`,
    '  headRepository { nameWithOwner }',
    '  author { __typename login }',
    '  assignees(first: 100) { nodes { login } }',
    '  latestReviews(first: 100) { nodes { author { login } authorAssociation state submittedAt } }',
    '  reviews(first: 100) { nodes { author { login } state submittedAt commit { oid } } }',
    '  reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name slug } } } }',
    `  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { ${checkContextFields} } } } } }`,
    '  reviewThreads(first: 100) {',
    '    nodes {',
    '      id isResolved',
    '      comments(first: 100) { nodes { author { __typename login } authorAssociation body createdAt reactionGroups { content viewerHasReacted } } }',
    '    }',
    '  }',
    '}',
].join('\n');

const moreCheckContextsQuery = [
    'query($owner: String!, $repo: String!, $sha: GitObjectID!, $after: String!) {',
    '  repository(owner: $owner, name: $repo) {',
    `    object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 100, after: $after) { ${checkContextFields} } } } }`,
    '  }',
    '}',
].join('\n');

/**
 * Every rollup entry from `page` on. A rerun adds entries rather than replacing them, so a busy PR
 * can pass one page, and a check missing from the rollup would read as not failing.
 *
 * Annotated because it recurses.
 */
async function fetchCheckContexts({
    owner,
    repoName,
    sha,
    page,
}: Readonly<{
    owner: string;
    repoName: string;
    sha: string;
    page: Readonly<typeof rawCheckContextPageShape.runtimeType>;
}>): Promise<Array<typeof rawCheckContextShape.runtimeType>> {
    if (!page.pageInfo.hasNextPage) {
        return [
            ...page.nodes,
        ];
    }
    const nextPage = assertWrapValidShape(
        await runGraphql(moreCheckContextsQuery, {
            owner,
            repo: repoName,
            sha,
            after: page.pageInfo.endCursor || '',
        }),
        moreCheckContextsResponseShape,
    ).repository?.object?.statusCheckRollup?.contexts;
    return [
        ...page.nodes,
        ...(nextPage
            ? await fetchCheckContexts({
                  owner,
                  repoName,
                  sha,
                  page: nextPage,
              })
            : []),
    ];
}

/** Rollup states no further check result can change while the head commit stays the same. */
const finishedRollupStates: ReadonlyArray<RawCheckResult> = [
    RawCheckResult.Success,
    RawCheckResult.Failure,
    RawCheckResult.Error,
];

/**
 * Each branch's complete rollup from its last check, by `owner/repo>branch`, so a finished rollup
 * on an unchanged head commit isn't paged through again.
 */
const checkContextCache = new Map<
    string,
    {
        sha: string;
        state: RawCheckResult;
        contexts: ReadonlyArray<typeof rawCheckContextShape.runtimeType>;
    }
>();

const branchChangeNodeShape = defineShape({
    number: 0,
    headRepository: nullableShape({
        nameWithOwner: '',
    }),
    updatedAt: '',
    headRefOid: '',
    mergeStateStatus: '',
    reviewDecision: nullableShape(''),
    headRef: nullableShape({
        target: nullableShape(
            partialShape({
                statusCheckRollup: nullableShape({
                    state: '',
                }),
            }),
        ),
    }),
    reviewThreads: {
        nodes: [
            {
                isResolved: false,
            },
        ],
    },
});

const branchChangeResponseShape = defineShape({
    /** Keyed by the query's `branch<index>` aliases. */
    repository: nullableShape(
        recordShape({
            keys: '',
            values: {
                nodes: [
                    branchChangeNodeShape,
                ],
            },
        }),
    ),
});

/**
 * The first of `prs` whose branch lives in `fullRepoName` itself. `headRefName` also matches a
 * fork's PR from a branch of the same name.
 */
function findOwnPr<
    Pr extends Readonly<{headRepository?: Readonly<{nameWithOwner: string}> | null | undefined}>,
>(prs: ReadonlyArray<Pr>, fullRepoName: string) {
    return prs.find(
        (pr) => pr.headRepository?.nameWithOwner.toLowerCase() === fullRepoName.toLowerCase(),
    );
}

/**
 * One aliased `pullRequests`, `branch<index>`, per branch, so every watched branch of a repo shares
 * one call. `headRef` rather than `commits(last: 1)`, which is a nested list and costs more.
 */
function buildBranchChangeQuery(branches: ReadonlyArray<string>) {
    return [
        `query($owner: String!, $repo: String!, ${branches
            .map((_branch, index) => `$branch${index}: String!`)
            .join(', ')}) {`,
        '  repository(owner: $owner, name: $repo) {',
        ...branches.map((_branch, index) => {
            return [
                `    branch${index}: pullRequests(headRefName: $branch${index}, states: [OPEN], first: 3, orderBy: {field: CREATED_AT, direction: DESC}) {`,
                '      nodes { number headRepository { nameWithOwner } updatedAt headRefOid mergeStateStatus reviewDecision headRef { target { ... on Commit { statusCheckRollup { state } } } } reviewThreads(first: 100) { nodes { isResolved } } }',
                '    }',
            ].join('\n');
        }),
        '  }',
        '}',
    ].join('\n');
}

/**
 * A key per branch that changes whenever the branch's open PR does in a way a watch check reads,
 * empty for a branch with no open PR.
 */
export function toBranchChangeKeys({
    branches,
    fullRepoName,
    repository,
}: Readonly<{
    branches: ReadonlyArray<string>;
    /** `owner/repo`, so a fork's PR from a same-named branch is skipped. */
    fullRepoName: string;
    repository: Readonly<typeof branchChangeResponseShape.runtimeType>['repository'];
}>) {
    return branches.map((_branch, index) => {
        const pr = findOwnPr(repository?.[`branch${index}`]?.nodes || [], fullRepoName);
        return pr ? createHash('sha256').update(JSON.stringify(pr)).digest('hex') : '';
    });
}

/**
 * Each repo's batched change check, by `owner/repo`, with when each branch last asked for it so a
 * branch no longer watched drops out of the batch.
 */
const branchChangeCache = new Map<
    string,
    {
        requestedAt: Readonly<Record<string, number>>;
        batch:
            | {
                  branches: ReadonlyArray<string>;
                  startedAt: number;
                  fetching: Promise<ReadonlyArray<string>>;
              }
            | undefined;
    }
>();

async function fetchBranchChangeKeys({
    owner,
    repoName,
    branches,
}: Readonly<{
    owner: string;
    repoName: string;
    branches: ReadonlyArray<string>;
}>) {
    return toBranchChangeKeys({
        branches,
        fullRepoName: `${owner}/${repoName}`,
        repository: assertWrapValidShape(
            await runGraphql(buildBranchChangeQuery(branches), {
                owner,
                repo: repoName,
                ...typedObjectFromEntries(
                    branches.map((branch, index) => {
                        return [
                            `branch${index}`,
                            branch,
                        ];
                    }),
                ),
            }),
            branchChangeResponseShape,
        ).repository,
    });
}

/**
 * The {@link toBranchChangeKeys} key of `branch`, from one call shared with every branch of the same
 * repo checked recently. Empty when the branch has no open PR or the call failed, which the caller
 * treats as changed.
 */
export async function readBranchChangeKey({
    owner,
    repoName,
    branch,
}: Readonly<{
    owner: string;
    repoName: string;
    branch: string;
}>) {
    const repoKey = `${owner}/${repoName}`;
    const now = Date.now();
    const cached = branchChangeCache.get(repoKey);
    const requestedAt: Readonly<Record<string, number>> = {
        ...typedObjectFromEntries(
            getObjectTypedEntries(cached?.requestedAt || {}).filter(
                ([
                    ,
                    at,
                ]) => {
                    return (
                        now - at <
                        convertDuration(
                            {
                                minutes: 15,
                            },
                            {
                                milliseconds: true,
                            },
                        ).milliseconds
                    );
                },
            ),
        ),
        [branch]: now,
    };
    const branches = getObjectTypedKeys(requestedAt);
    const batch =
        cached?.batch &&
        cached.batch.branches.includes(branch) &&
        now - cached.batch.startedAt <
            convertDuration(
                {
                    minutes: 5,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds
            ? cached.batch
            : {
                  branches,
                  startedAt: now,
                  fetching: fetchBranchChangeKeys({
                      owner,
                      repoName,
                      branches,
                  }),
              };
    branchChangeCache.set(repoKey, {
        requestedAt,
        batch,
    });
    try {
        return (await batch.fetching)[batch.branches.indexOf(branch)] || '';
    } catch {
        const current = branchChangeCache.get(repoKey);
        if (current?.batch === batch) {
            branchChangeCache.set(repoKey, {
                ...current,
                batch: undefined,
            });
        }
        return '';
    }
}

/** Runs `gh` in `folder`, so commands that default to the current branch's PR find it. */
export async function runGhIn(folder: string, args: ReadonlyArray<string>) {
    return (
        await runGhCommand({
            args,
            cwd: folder,
        })
    ).stdout;
}

/** The PR of `branch`. `undefined` when the branch has never had a PR. */
export async function fetchPrCheck({
    folder,
    owner,
    repoName,
    branch,
    viewerLogin,
}: Readonly<{
    folder: string;
    owner: string;
    repoName: string;
    branch: string;
    viewerLogin: string;
}>) {
    const checkedAt = toUtcIsoString(getNowInUtcTimezone());
    const repository = assertWrapValidShape(
        await runGraphql(watchedPrQuery, {
            owner,
            repo: repoName,
            branch,
        }),
        watchedPrResponseShape,
    ).repository;
    /** A branch reused for a new PR keeps its closed ones, so the open one wins. */
    const pr =
        findOwnPr(repository?.open.nodes || [], `${owner}/${repoName}`) ||
        findOwnPr(repository?.closed.nodes || [], `${owner}/${repoName}`);
    if (!pr) {
        return undefined;
    }
    await shareFolderPrStatus({
        folder,
        slug: {
            owner,
            name: repoName,
        },
        pr,
    });
    const headCommit = pr.commits.nodes[0]?.commit;
    const checkContextCacheKey = `${owner}/${repoName}>${branch}`;
    const cachedCheckContexts = checkContextCache.get(checkContextCacheKey);
    const checkContexts = headCommit?.statusCheckRollup
        ? cachedCheckContexts?.sha === headCommit.oid &&
          cachedCheckContexts.state === headCommit.statusCheckRollup.state &&
          finishedRollupStates.includes(headCommit.statusCheckRollup.state)
            ? cachedCheckContexts.contexts
            : await fetchCheckContexts({
                  owner,
                  repoName,
                  sha: headCommit.oid,
                  page: headCommit.statusCheckRollup.contexts,
              })
        : [];
    if (headCommit?.statusCheckRollup) {
        checkContextCache.set(checkContextCacheKey, {
            sha: headCommit.oid,
            state: headCommit.statusCheckRollup.state,
            contexts: checkContexts,
        });
    }
    return classifyPrCheck({
        pr: {
            ...pr,
            /**
             * In the `app/<login>` form `gh pr view` prints for a bot, which no review author's
             * login matches.
             */
            author: pr.author && {
                login:
                    pr.author.__typename === RawActorType.Bot
                        ? `app/${pr.author.login}`
                        : pr.author.login,
            },
            baseRefOid: pr.baseRef?.target?.oid || '',
            assignees: pr.assignees.nodes,
            latestReviews: pr.latestReviews.nodes,
            reviews: pr.reviews.nodes,
            reviewRequests: pr.reviewRequests.nodes
                .map((request) => request.requestedReviewer)
                .filter(check.isTruthy),
            statusCheckRollup: checkContexts.map((checkContext) => {
                return {
                    name: checkContext.name || '',
                    context: checkContext.context || '',
                    workflowName: checkContext.checkSuite?.workflowRun?.workflow.name || '',
                    status: checkContext.status || '',
                    conclusion: checkContext.conclusion || '',
                    state: checkContext.state || '',
                    startedAt: checkContext.startedAt || '',
                    createdAt: checkContext.createdAt || '',
                    detailsUrl: checkContext.detailsUrl || '',
                };
            }),
        },
        threads: pr.reviewThreads.nodes,
        viewerLogin,
        checkedAt,
        trustedBotLogins: [
            ...(await readReviewHost().loadSettings()).forges[ForgeType.Github].trustedBotLogins,
            ...(await readReviewHost().loadFolderSettings(folder)).flatMap((folderSettings) => {
                return folderSettings.forges?.[ForgeType.Github]?.trustedBotLogins || [];
            }),
        ],
    });
}
