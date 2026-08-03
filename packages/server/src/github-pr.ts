// cspell:words HOORAY, unresolve

import {
    GitHubCheckState,
    GitHubCommentTarget,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
    type GitHubCheck,
    type GitHubComment,
    type GitHubPr,
    type GitHubReactionGroup,
    type GitHubReview,
    type GitHubReviewRequest,
    type GitHubReviewThread,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getObjectTypedEntries} from '@augment-vir/common';
import {getCurrentBranch, getRepoSlug, runGh} from './git.js';

/**
 * Per-connection caps on the one PR query. Each `first:` multiplies into GitHub's GraphQL cost
 * calculation, so these are sized to cover a realistically large review (fifty inline threads,
 * fifty conversation comments) without paying for the pathological case. A PR past these limits
 * shows its first N and the "Open on GitHub" link handles the rest.
 */
const maxThreads = 50;
const maxThreadComments = 20;
const maxConversationComments = 50;
const maxReviews = 20;

const reactionGroupFields = 'reactionGroups { content viewerHasReacted reactors { totalCount } }';

const commentFields = [
    'id',
    'body',
    'bodyHTML',
    'createdAt',
    'url',
    'author { login avatarUrl }',
    reactionGroupFields,
].join(' ');

/**
 * Every individual CI entry on the head commit, not just the rollup verdict — the pane lists them
 * the way github.com's merge box does, so a red rollup says _which_ job failed. `contexts` is a
 * union: Actions jobs are `CheckRun` (with a `conclusion` once finished) and third-party statuses
 * are `StatusContext` (with a `state`).
 */
const maxCheckRuns = 50;

const statusCheckRollupFields = [
    'statusCheckRollup {',
    '  state',
    `  contexts(first: ${maxCheckRuns}) {`,
    '    nodes {',
    '      __typename',
    '      ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { workflow { name } } } }',
    '      ... on StatusContext { context state targetUrl description }',
    '    }',
    '  }',
    '}',
].join('\n');

const prQuery = [
    'query($owner: String!, $name: String!, $branch: String!) {',
    '  repository(owner: $owner, name: $name) {',
    '    pullRequests(headRefName: $branch, states: [OPEN, MERGED, CLOSED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {',
    '      nodes {',
    '        id number url title titleHTML body bodyHTML state isDraft baseRefName headRefName createdAt',
    '        author { login avatarUrl }',
    `        commits(last: 1) { nodes { commit { ${statusCheckRollupFields} } } }`,
    `        latestReviews(first: ${maxReviews}) { nodes { id state body bodyHTML createdAt url author { login avatarUrl } } }`,
    /**
     * A requested reviewer is a `User`, a `Bot`, a `Mannequin`, or a `Team`; only `Team` is named
     * rather than logged in.
     */
    `        reviewRequests(first: ${maxReviews}) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { name avatarUrl } } } }`,
    `        reviewThreads(first: ${maxThreads}) {`,
    '          nodes {',
    '            id path line isResolved isOutdated viewerCanResolve viewerCanUnresolve',
    `            comments(first: ${maxThreadComments}) { nodes { ${commentFields} diffHunk } }`,
    '          }',
    '        }',
    `        comments(first: ${maxConversationComments}) { nodes { ${commentFields} } }`,
    '      }',
    '    }',
    '  }',
    '}',
].join('\n');

const replyMutation = [
    'mutation($subjectId: ID!, $body: String!) {',
    '  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $subjectId, body: $body}) {',
    '    comment { id }',
    '  }',
    '}',
].join('\n');

const conversationCommentMutation = [
    'mutation($subjectId: ID!, $body: String!) {',
    '  addComment(input: {subjectId: $subjectId, body: $body}) { clientMutationId }',
    '}',
].join('\n');

const commentMutations: Readonly<Record<GitHubCommentTarget, string>> = {
    [GitHubCommentTarget.Thread]: replyMutation,
    [GitHubCommentTarget.Conversation]: conversationCommentMutation,
};

const addReactionMutation = [
    'mutation($subjectId: ID!, $content: ReactionContent!) {',
    '  addReaction(input: {subjectId: $subjectId, content: $content}) { clientMutationId }',
    '}',
].join('\n');

const removeReactionMutation = [
    'mutation($subjectId: ID!, $content: ReactionContent!) {',
    '  removeReaction(input: {subjectId: $subjectId, content: $content}) { clientMutationId }',
    '}',
].join('\n');

const resolveThreadMutation = [
    'mutation($threadId: ID!) {',
    '  resolveReviewThread(input: {threadId: $threadId}) { thread { id } }',
    '}',
].join('\n');

const unresolveThreadMutation = [
    'mutation($threadId: ID!) {',
    '  unresolveReviewThread(input: {threadId: $threadId}) { thread { id } }',
    '}',
].join('\n');

type GraphqlResponse = {
    data?: unknown;
    errors?: ReadonlyArray<{message?: string}>;
};

/**
 * Run one GraphQL document through `gh api graphql` and hand back its `data`. Variables go through
 * `-f` (always strings), which GraphQL coerces into the declared variable types — including the
 * `ReactionContent` enum, whose values are already GitHub's own literals.
 *
 * Throws with GitHub's own message on failure. Unlike the sidebar's polling sweep, this runs
 * because the user opened the pane, so a rate-limit or auth failure belongs on screen rather than
 * silently flipping a kill-switch.
 */
async function runGraphql(
    query: string,
    variables: Readonly<Record<string, string>>,
): Promise<unknown> {
    const result = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        ...getObjectTypedEntries(variables).flatMap(
            ([
                key,
                value,
            ]) => [
                '-f',
                `${key}=${value}`,
            ],
        ),
    ]);
    const parsed: GraphqlResponse = result.stdout
        ? (JSON.parse(result.stdout) as GraphqlResponse)
        : {};
    const errorMessage = parsed.errors?.map((error) => error.message).join('; ');
    if (errorMessage) {
        throw new Error(`GitHub rejected the request: ${errorMessage}`);
    } else if (result.exitCode === 0) {
        return parsed.data;
    } else {
        throw new Error(`GitHub request failed: ${result.stderr.trim() || 'unknown gh failure'}`);
    }
}

const prStatesByGraphqlValue: Readonly<Record<string, GitHubPrState>> = {
    OPEN: GitHubPrState.Open,
    MERGED: GitHubPrState.Merged,
    CLOSED: GitHubPrState.Closed,
};

const checkStatesByGraphqlValue: Readonly<Record<string, GitHubCheckState>> = {
    SUCCESS: GitHubCheckState.Success,
    FAILURE: GitHubCheckState.Failure,
    ERROR: GitHubCheckState.Failure,
    PENDING: GitHubCheckState.Pending,
    EXPECTED: GitHubCheckState.Pending,
};

const reviewStatesByGraphqlValue: Readonly<Record<string, GitHubReviewState>> = {
    APPROVED: GitHubReviewState.Approved,
    CHANGES_REQUESTED: GitHubReviewState.ChangesRequested,
    COMMENTED: GitHubReviewState.Commented,
    DISMISSED: GitHubReviewState.Dismissed,
    PENDING: GitHubReviewState.Pending,
};

type RawAuthor = {
    login?: string;
    avatarUrl?: string;
};

type RawReactionGroup = {
    content?: string;
    viewerHasReacted?: boolean;
    reactors?: {totalCount?: number};
};

type RawComment = {
    id?: string;
    body?: string;
    bodyHTML?: string;
    createdAt?: string;
    url?: string;
    diffHunk?: string;
    author?: RawAuthor | null;
    reactionGroups?: ReadonlyArray<RawReactionGroup>;
};

type RawThread = {
    id?: string;
    path?: string;
    line?: number | null;
    isResolved?: boolean;
    isOutdated?: boolean;
    viewerCanResolve?: boolean;
    viewerCanUnresolve?: boolean;
    comments?: {nodes?: ReadonlyArray<RawComment>};
};

type RawReview = {
    id?: string;
    state?: string;
    body?: string;
    bodyHTML?: string;
    createdAt?: string;
    url?: string;
    author?: RawAuthor | null;
};

type RawReviewRequest = {
    requestedReviewer?: {
        /** Users, bots, and mannequins have a `login`; teams have a `name`. */
        login?: string;
        name?: string;
        avatarUrl?: string;
    } | null;
};

/** One `contexts` union member — the `CheckRun` fields and `StatusContext` fields both land here. */
type RawCheckContext = {
    __typename?: string;
    /** `CheckRun`. */
    name?: string;
    conclusion?: string | null;
    status?: string;
    detailsUrl?: string;
    checkSuite?: {workflowRun?: {workflow?: {name?: string}} | null} | null;
    /** `StatusContext`. */
    context?: string;
    state?: string;
    targetUrl?: string | null;
    description?: string | null;
};

type RawStatusCheckRollup = {
    state?: string;
    contexts?: {nodes?: ReadonlyArray<RawCheckContext>};
};

type RawPr = {
    id?: string;
    number?: number;
    url?: string;
    title?: string;
    titleHTML?: string;
    body?: string;
    bodyHTML?: string;
    state?: string;
    isDraft?: boolean;
    baseRefName?: string;
    headRefName?: string;
    createdAt?: string;
    author?: RawAuthor | null;
    commits?: {nodes?: ReadonlyArray<{commit?: {statusCheckRollup?: RawStatusCheckRollup | null}}>};
    latestReviews?: {nodes?: ReadonlyArray<RawReview>};
    reviewRequests?: {nodes?: ReadonlyArray<RawReviewRequest>};
    reviewThreads?: {nodes?: ReadonlyArray<RawThread>};
    comments?: {nodes?: ReadonlyArray<RawComment>};
};

/**
 * GitHub returns a null `author` for comments left by a deleted account. "ghost" is what github.com
 * itself shows in that spot.
 */
const deletedAuthorLogin = 'ghost';

function toReactionGroups(raw: ReadonlyArray<RawReactionGroup> | undefined): GitHubReactionGroup[] {
    return (
        (raw || [])
            .map((group) => {
                /** Drop any reaction GitHub adds later that this build doesn't know how to render. */
                if (!check.isEnumValue(group.content, GitHubReaction)) {
                    return undefined;
                }
                return {
                    reaction: group.content,
                    count: group.reactors?.totalCount || 0,
                    viewerHasReacted: !!group.viewerHasReacted,
                };
            })
            .filter(check.isTruthy)
            /** GitHub returns a group per reaction kind whether or not anyone used it. */
            .filter((group) => group.count > 0)
    );
}

function toComment(raw: Readonly<RawComment>): GitHubComment {
    return {
        id: raw.id || '',
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        body: raw.body || '',
        bodyHtml: raw.bodyHTML || '',
        createdAt: raw.createdAt || '',
        url: raw.url || '',
        reactions: toReactionGroups(raw.reactionGroups),
    };
}

function toThread(raw: Readonly<RawThread>): GitHubReviewThread {
    const comments = (raw.comments?.nodes || []).map(toComment);
    return {
        id: raw.id || '',
        path: raw.path || '',
        line: raw.line ?? null,
        isResolved: !!raw.isResolved,
        isOutdated: !!raw.isOutdated,
        /** Which permission matters depends on which direction the button would move the thread. */
        viewerCanResolve: raw.isResolved ? !!raw.viewerCanUnresolve : !!raw.viewerCanResolve,
        diffHunk: raw.comments?.nodes?.[0]?.diffHunk || '',
        comments,
    };
}

function toReview(raw: Readonly<RawReview>): GitHubReview {
    return {
        id: raw.id || '',
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        state: reviewStatesByGraphqlValue[raw.state || ''] || GitHubReviewState.Commented,
        body: raw.body || '',
        bodyHtml: raw.bodyHTML || '',
        createdAt: raw.createdAt || '',
        url: raw.url || '',
    };
}

/**
 * Requests whose reviewer GitHub won't name — a deleted account, or a team the token can't see —
 * are dropped rather than rendered as a blank row.
 */
function toReviewRequests(raw: ReadonlyArray<RawReviewRequest> | undefined): GitHubReviewRequest[] {
    return (raw || [])
        .map((node) => {
            return {
                reviewer: node.requestedReviewer?.login || node.requestedReviewer?.name || '',
                reviewerAvatarUrl: node.requestedReviewer?.avatarUrl || '',
            };
        })
        .filter((request) => !!request.reviewer);
}

/**
 * A `CheckRun`'s verdict lives in `conclusion` once it finishes and is null while it runs, so an
 * unfinished run reads as pending regardless of its `status`. A `StatusContext` only ever has
 * `state`. Both vocabularies share {@link checkStatesByGraphqlValue} because their values overlap
 * (`SUCCESS`, `FAILURE`, `PENDING`) — the ones that don't are handled here.
 */
const checkRunConclusions: Readonly<Record<string, GitHubCheckState>> = {
    SUCCESS: GitHubCheckState.Success,
    FAILURE: GitHubCheckState.Failure,
    TIMED_OUT: GitHubCheckState.Failure,
    STARTUP_FAILURE: GitHubCheckState.Failure,
    ACTION_REQUIRED: GitHubCheckState.Failure,
    /** Cancelled, skipped, neutral, and stale aren't failures — they're "nothing to report". */
    CANCELLED: GitHubCheckState.None,
    SKIPPED: GitHubCheckState.None,
    NEUTRAL: GitHubCheckState.None,
    STALE: GitHubCheckState.None,
};

function toCheck(raw: Readonly<RawCheckContext>): GitHubCheck {
    const isCheckRun = raw.__typename === 'CheckRun';
    return {
        name: (isCheckRun ? raw.name : raw.context) || '',
        workflow: raw.checkSuite?.workflowRun?.workflow?.name || '',
        state: isCheckRun
            ? raw.conclusion
                ? checkRunConclusions[raw.conclusion] || GitHubCheckState.None
                : GitHubCheckState.Pending
            : checkStatesByGraphqlValue[raw.state || ''] || GitHubCheckState.None,
        url: (isCheckRun ? raw.detailsUrl : raw.targetUrl) || '',
        description: raw.description || '',
    };
}

/**
 * Flatten one GraphQL PR node into the shape the pane consumes. Exported for tests: this is the
 * only part of the GitHub integration that can be exercised without a network call, and it's where
 * the enum translations and null-author fallbacks live.
 */
export function toPr(raw: Readonly<RawPr>): GitHubPr {
    const graphqlState = prStatesByGraphqlValue[raw.state || ''] || GitHubPrState.Closed;
    const rollup = raw.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    return {
        id: raw.id || '',
        number: raw.number || 0,
        url: raw.url || '',
        title: raw.title || '',
        titleHtml: raw.titleHTML || '',
        body: raw.body || '',
        bodyHtml: raw.bodyHTML || '',
        /** Draft isn't a GraphQL `state` — it's a flag on top of `OPEN`. */
        state:
            graphqlState === GitHubPrState.Open && raw.isDraft ? GitHubPrState.Draft : graphqlState,
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        baseRefName: raw.baseRefName || '',
        headRefName: raw.headRefName || '',
        createdAt: raw.createdAt || '',
        checks: checkStatesByGraphqlValue[rollup?.state || ''] || GitHubCheckState.None,
        checkRuns: (rollup?.contexts?.nodes || []).map(toCheck),
        reviews: (raw.latestReviews?.nodes || []).map(toReview),
        reviewRequests: toReviewRequests(raw.reviewRequests?.nodes),
        threads: (raw.reviewThreads?.nodes || []).map(toThread),
        comments: (raw.comments?.nodes || []).map(toComment),
    };
}

/**
 * How long a fetched PR is served back without asking GitHub again. Matches the pane's own refresh
 * cadence, so re-opening the tab or switching folders back and forth costs nothing, while the
 * pane's timer still lands on a real query each time it fires.
 */
const prCacheTtlMs = 5 * 60 * 1000;

/**
 * Last PR fetched per folder. Lives here rather than in the browser so every client — and a reload
 * — shares one GitHub rate-limit budget, and so a reopened tab paints without a round trip to
 * GitHub.
 */
const prCacheByFolder = new Map<
    string,
    {
        pr: GitHubPr | null;
        fetchedAt: number;
    }
>();

/**
 * Everything the GitHub pane needs for one folder, or null when there's nothing to show: the folder
 * isn't a git checkout, its `origin` isn't on github.com, or the branch has no PR.
 */
export async function fetchFolderPr({
    folder,
    forceRefresh,
}: Readonly<{
    folder: string;
    forceRefresh?: boolean | undefined;
}>): Promise<GitHubPr | null> {
    const cached = prCacheByFolder.get(folder);
    if (cached && !forceRefresh && Date.now() - cached.fetchedAt < prCacheTtlMs) {
        return cached.pr;
    }
    const pr = await queryFolderPr(folder);
    prCacheByFolder.set(folder, {
        pr,
        fetchedAt: Date.now(),
    });
    return pr;
}

async function queryFolderPr(folder: string): Promise<GitHubPr | null> {
    const [
        slug,
        branch,
    ] = await Promise.all([
        getRepoSlug(folder),
        getCurrentBranch(folder),
    ]);
    if (!slug || !branch) {
        return null;
    }
    const data = (await runGraphql(prQuery, {
        owner: slug.owner,
        name: slug.name,
        branch,
    })) as
        | {
              repository?: {pullRequests?: {nodes?: ReadonlyArray<RawPr>}};
          }
        | undefined;
    const node = data?.repository?.pullRequests?.nodes?.[0];
    return node ? toPr(node) : null;
}

export async function postComment({
    target,
    subjectId,
    body,
}: Readonly<{
    target: GitHubCommentTarget;
    subjectId: string;
    body: string;
}>): Promise<void> {
    await runGraphql(commentMutations[target], {
        subjectId,
        body,
    });
}

export async function setReaction({
    subjectId,
    reaction,
    add,
}: Readonly<{
    subjectId: string;
    reaction: GitHubReaction;
    add: boolean;
}>): Promise<void> {
    await runGraphql(add ? addReactionMutation : removeReactionMutation, {
        subjectId,
        content: reaction,
    });
}

export async function setThreadResolved({
    threadId,
    resolved,
}: Readonly<{
    threadId: string;
    resolved: boolean;
}>): Promise<void> {
    await runGraphql(resolved ? resolveThreadMutation : unresolveThreadMutation, {
        threadId,
    });
}
