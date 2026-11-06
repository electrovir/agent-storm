import {ForgeType, GitHubReaction} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getObjectTypedKeys, removeDuplicates} from '@augment-vir/common';
import {getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {
    assertWrapValidShape,
    defineShape,
    enumShape,
    exactShape,
    nullableShape,
    parseJsonWithShape,
    partialShape,
    unionShape,
} from 'object-shape-tester';
import {loadConfig} from './config.js';
import {runGraphql} from './github-pr.js';
import {
    collaboratorAssociations,
    failedCheckResults,
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
} from './github-raw-enums.js';
import {runCommand} from './run-command.js';

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

/** `gh` prints an empty string for a field the check has no value for. */
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
    }),
);

export type RawStatusCheck = typeof rawStatusCheckShape.runtimeType;

/** The fields `fetchPrCheck` asks `gh pr view --json` for. */
const rawPrViewFields = {
    number: 0,
    url: '',
    title: '',
    body: '',
    headRefName: '',
    headRefOid: '',
    baseRefName: '',
    author: rawLoginShape,
    isDraft: false,
    state: enumShape(RawPrState),
    /** Empty when the repo doesn't require a review. */
    reviewDecision: unionShape(enumShape(RawReviewDecision), exactShape('')),
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
    reviewRequests: [
        partialShape({
            login: '',
            name: '',
            slug: '',
        }),
    ],
    statusCheckRollup: nullableShape([
        rawStatusCheckShape,
    ]),
};

const rawPrViewShape = defineShape(rawPrViewFields);

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

const reviewThreadsResponseShape = defineShape({
    repository: nullableShape({
        pullRequest: nullableShape({
            reviewThreads: {
                nodes: [
                    rawReviewThreadShape,
                ],
            },
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

function mentionsAny({body, logins}: Readonly<{body: string; logins: ReadonlyArray<string>}>) {
    const lowerBody = body.toLowerCase();
    return logins.some((login) => lowerBody.includes(`@${login.toLowerCase()}`));
}

/**
 * Only comments from repo collaborators and trusted review bots can make a thread work, so a
 * stranger's comment on a public repo never steers the AI. Anything else waits for the viewer's 👍.
 * A hand-off is an `AI: ` reply that @-mentions an assignee: the thread waits on a human until a
 * collaborator replies after it.
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
    const lastHandOffIndex = comments.findLastIndex((comment) => {
        return (
            isTrustedComment({
                comment,
                trustedBotLogins,
            }) &&
            isAiBody(comment.body) &&
            mentionsAny({
                body: comment.body,
                logins: assignees,
            })
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
                return checkStartedAt(statusCheck) > checkStartedAt(latest) ? statusCheck : latest;
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
        .filter((thread) => !thread.isResolved)
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
        needs,
        isReadyToMerge: isNothingOpen && mergeableMergeStates[mergeState],
        isAwaitingRequestedReview,
        isAwaitingViewerReview:
            isAwaitingRequestedReview && requestedReviewers.includes(viewerLogin),
        isBlockedOnHuman: thumbsUpWaitCount > 0 || isAwaitingRequestedReview,
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

/** The number is written into the query because `runGraphql` sends every variable as a string. */
function createReviewThreadsQuery(prNumber: number) {
    return `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: ${prNumber}) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes {
              author { __typename login }
              authorAssociation
              body
              createdAt
              reactionGroups { content viewerHasReacted }
            }
          }
        }
      }
    }
  }
}`;
}

/** Runs `gh` in `folder`, so commands that default to the current branch's PR find it. */
export async function runGhIn(folder: string, args: ReadonlyArray<string>) {
    return (
        await runCommand('gh', [...args], {
            cwd: folder,
            maxBuffer: 50 * 1024 * 1024,
            timeout: {
                minutes: 1,
            },
        })
    ).stdout;
}

/**
 * The PR of the branch checked out in `folder`. `undefined` when the branch has never had a PR, and
 * throws for any other `gh` failure.
 */
export async function fetchPrCheck({
    folder,
    owner,
    repoName,
    viewerLogin,
}: Readonly<{
    folder: string;
    owner: string;
    repoName: string;
    viewerLogin: string;
}>) {
    const checkedAt = toUtcIsoString(getNowInUtcTimezone());
    const prJson = await runGhIn(folder, [
        'pr',
        'view',
        '--json',
        getObjectTypedKeys(rawPrViewFields).join(','),
    ]).catch((error: unknown) => {
        if (
            check.isObject(error) &&
            check.isString(error.stderr) &&
            error.stderr.includes('no pull requests found')
        ) {
            return undefined;
        }
        throw error;
    });
    if (!prJson) {
        return undefined;
    }
    const pr = parseJsonWithShape(prJson, rawPrViewShape);
    const threadsResponse = assertWrapValidShape(
        await runGraphql(createReviewThreadsQuery(pr.number), {
            owner,
            repo: repoName,
        }),
        reviewThreadsResponseShape,
    );
    return classifyPrCheck({
        pr,
        threads: threadsResponse.repository?.pullRequest?.reviewThreads.nodes || [],
        viewerLogin,
        checkedAt,
        trustedBotLogins: (await loadConfig()).forges[ForgeType.Github].trustedBotLogins,
    });
}
