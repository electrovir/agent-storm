// cspell:words hooray unresolve

import {
    GitHubCheckState,
    GitHubCommentTarget,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getObjectTypedEntries, wrapInTry} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {
    assertWrapValidShape,
    defineShape,
    enumShape,
    exactShape,
    nullableShape,
    optionalShape,
    parseJsonWithShape,
    unionShape,
    unknownShape,
} from 'object-shape-tester';
import {getCurrentBranch, getRepoSlug, runGh} from './git.js';
import {
    checkResultStates,
    RawCheckContextType,
    RawCheckResult,
    RawCheckStatus,
    RawPrState,
    RawReviewState,
} from './github-raw-enums.js';

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

/** Ten names is as many as github.com lists in a reaction's hover text before "and N more". */
const reactionGroupFields =
    'reactionGroups { content viewerHasReacted reactors(first: 10) { totalCount nodes { ... on Actor { login } } } }';

/** The fields {@link rawReviewShape} validates. */
export const reviewFields = 'id state body bodyHTML createdAt url author { login avatarUrl }';

export const commentFields = [
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

/**
 * A requested reviewer is a `User`, a `Bot`, a `Mannequin`, or a `Team`; only `Team` is named
 * rather than logged in.
 */
export const reviewRequestFields =
    'requestedReviewer { __typename ... on User { login avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { name avatarUrl } }';

const prQuery = [
    'query($owner: String!, $name: String!, $branch: String!) {',
    '  repository(owner: $owner, name: $name) {',
    '    pullRequests(headRefName: $branch, states: [OPEN, MERGED, CLOSED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {',
    '      nodes {',
    '        id number url title titleHTML body bodyHTML state isDraft baseRefName headRefName createdAt',
    '        author { login avatarUrl }',
    '        baseRepository { name owner { login } }',
    `        commits(last: 1) { nodes { commit { ${statusCheckRollupFields} } } }`,
    `        latestReviews(first: ${maxReviews}) { nodes { ${reviewFields} } }`,
    `        reviewRequests(first: ${maxReviews}) { nodes { ${reviewRequestFields} } }`,
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

const graphqlResponseShape = defineShape({
    data: nullableShape(unknownShape()),
    errors: nullableShape([
        {
            message: '',
        },
    ]),
});

/**
 * Run one GraphQL document through `gh api graphql` and hand back its `data`, for the caller to
 * validate against the shape of what it asked for. Variables go through `-f` (always strings),
 * which GraphQL coerces into the declared variable types — including the `ReactionContent` enum,
 * whose values are already GitHub's own literals.
 *
 * Throws with GitHub's own message on failure. Unlike the sidebar's polling sweep, this runs
 * because the user opened the pane, so a rate-limit or auth failure belongs on screen rather than
 * silently flipping a kill-switch.
 */
export async function runGraphql(query: string, variables: Readonly<Record<string, string>>) {
    const result = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        ...getObjectTypedEntries(variables).flatMap(
            ([
                key,
                value,
            ]) => {
                return [
                    '-f',
                    `${key}=${value}`,
                ];
            },
        ),
    ]);
    /**
     * On an HTTP error `gh` prints the response body to stdout, and GitHub's 5xx bodies are HTML
     * pages, not JSON.
     */
    const parsed = wrapInTry(
        () => parseJsonWithShape(result.stdout || '{}', graphqlResponseShape),
        {
            fallbackValue: undefined,
        },
    );
    if (!parsed) {
        throw new Error(
            `GitHub request failed: ${result.stderr.trim() || 'GitHub sent back a non-JSON response'}. Try again shortly.`,
        );
    }
    const errorMessage = parsed.errors?.map((error) => error.message).join('; ');
    if (errorMessage) {
        throw new Error(`GitHub rejected the request: ${errorMessage}`);
    } else if (result.exitCode === 0) {
        return parsed.data;
    } else {
        throw new Error(`GitHub request failed: ${result.stderr.trim() || 'unknown gh failure'}`);
    }
}

const prStates: Readonly<Record<RawPrState, GitHubPrState>> = {
    [RawPrState.Open]: GitHubPrState.Open,
    [RawPrState.Merged]: GitHubPrState.Merged,
    [RawPrState.Closed]: GitHubPrState.Closed,
};

const reviewStates: Readonly<Record<RawReviewState, GitHubReviewState>> = {
    [RawReviewState.Approved]: GitHubReviewState.Approved,
    [RawReviewState.ChangesRequested]: GitHubReviewState.ChangesRequested,
    [RawReviewState.Commented]: GitHubReviewState.Commented,
    [RawReviewState.Dismissed]: GitHubReviewState.Dismissed,
    [RawReviewState.Pending]: GitHubReviewState.Pending,
};

/** Null for a deleted account. */
const rawAuthorShape = defineShape(
    nullableShape({
        login: '',
        avatarUrl: '',
    }),
);

/**
 * `content` stays a plain string so a reaction GitHub adds later is dropped by
 * {@link toReactionGroups} rather than failing the whole answer.
 */
const rawReactionGroupShape = defineShape({
    content: '',
    viewerHasReacted: false,
    reactors: {
        totalCount: 0,
        nodes: [
            nullableShape({
                login: '',
            }),
        ],
    },
});

const rawCommentFields = {
    id: '',
    body: '',
    bodyHTML: '',
    createdAt: '',
    url: '',
    author: rawAuthorShape,
    reactionGroups: nullableShape([
        rawReactionGroupShape,
    ]),
};

const rawCommentShape = defineShape(rawCommentFields);

/** The fields of a review thread that {@link toThread} reads. */
export const rawThreadFields = {
    id: '',
    path: '',
    line: nullableShape(0),
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: false,
    viewerCanUnresolve: false,
    comments: {
        nodes: [
            defineShape({
                ...rawCommentFields,
                diffHunk: '',
            }),
        ],
    },
};

const rawThreadShape = defineShape(rawThreadFields);

/**
 * The fields of {@link reviewFields}. `state` stays a plain string so a state GitHub adds later
 * reads as a comment instead of failing the whole answer.
 */
export const rawReviewShape = defineShape({
    id: '',
    state: '',
    body: '',
    bodyHTML: '',
    createdAt: '',
    url: '',
    author: rawAuthorShape,
});

/** Null for a deleted account. Users, bots, and mannequins have a `login`; teams have a `name`. */
export const rawReviewRequestShape = defineShape({
    requestedReviewer: nullableShape({
        login: optionalShape(''),
        name: optionalShape(''),
        avatarUrl: nullableShape(''),
    }),
});

const rawCheckRunShape = defineShape({
    __typename: exactShape(RawCheckContextType.CheckRun),
    name: '',
    /** Null until the run finishes. */
    conclusion: nullableShape(enumShape(RawCheckResult)),
    status: enumShape(RawCheckStatus),
    detailsUrl: nullableShape(''),
    checkSuite: {
        workflowRun: nullableShape({
            workflow: {
                name: '',
            },
        }),
    },
});

const rawStatusContextShape = defineShape({
    __typename: exactShape(RawCheckContextType.StatusContext),
    context: '',
    state: enumShape(RawCheckResult),
    targetUrl: nullableShape(''),
    description: nullableShape(''),
});

const rawCheckContextShape = defineShape(unionShape(rawCheckRunShape, rawStatusContextShape));

export const rawPrShape = defineShape({
    id: '',
    number: 0,
    url: '',
    title: '',
    titleHTML: '',
    body: '',
    bodyHTML: '',
    state: enumShape(RawPrState),
    isDraft: false,
    baseRefName: '',
    headRefName: '',
    createdAt: '',
    author: rawAuthorShape,
    baseRepository: nullableShape({
        name: '',
        owner: {
            login: '',
        },
    }),
    commits: {
        nodes: [
            {
                commit: {
                    statusCheckRollup: nullableShape({
                        state: enumShape(RawCheckResult),
                        contexts: {
                            nodes: [
                                rawCheckContextShape,
                            ],
                        },
                    }),
                },
            },
        ],
    },
    latestReviews: {
        nodes: [
            rawReviewShape,
        ],
    },
    reviewRequests: {
        nodes: [
            rawReviewRequestShape,
        ],
    },
    reviewThreads: {
        nodes: [
            rawThreadShape,
        ],
    },
    comments: {
        nodes: [
            rawCommentShape,
        ],
    },
});

const prQueryResponseShape = defineShape({
    repository: nullableShape({
        pullRequests: {
            nodes: [
                rawPrShape,
            ],
        },
    }),
});

/**
 * GitHub returns a null `author` for comments left by a deleted account. "ghost" is what github.com
 * itself shows in that spot.
 */
const deletedAuthorLogin = 'ghost';

function toReactionGroups(
    raw: ReadonlyArray<Readonly<typeof rawReactionGroupShape.runtimeType>> | null | undefined,
) {
    return (
        (raw || [])
            .map((group) => {
                /** Drop any reaction GitHub adds later that this build doesn't know how to render. */
                if (!check.isEnumValue(group.content, GitHubReaction)) {
                    return undefined;
                }
                return {
                    reaction: group.content,
                    count: group.reactors.totalCount,
                    viewerHasReacted: group.viewerHasReacted,
                    reactors: group.reactors.nodes
                        .map((node) => node?.login)
                        .filter(check.isTruthy),
                };
            })
            .filter(check.isTruthy)
            /** GitHub returns a group per reaction kind whether or not anyone used it. */
            .filter((group) => group.count > 0)
    );
}

function toComment(raw: Readonly<typeof rawCommentShape.runtimeType>) {
    return {
        id: raw.id,
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        body: raw.body,
        bodyHtml: raw.bodyHTML,
        createdAt: raw.createdAt,
        url: raw.url,
        reactions: toReactionGroups(raw.reactionGroups),
    };
}

export function toThread(raw: Readonly<typeof rawThreadShape.runtimeType>) {
    return {
        id: raw.id,
        path: raw.path,
        line: raw.line ?? null,
        isResolved: raw.isResolved,
        isOutdated: raw.isOutdated,
        /** Which permission matters depends on which direction the button would move the thread. */
        viewerCanResolve: raw.isResolved ? raw.viewerCanUnresolve : raw.viewerCanResolve,
        diffHunk: raw.comments.nodes[0]?.diffHunk || '',
        comments: raw.comments.nodes.map(toComment),
    };
}

export function toReview(raw: Readonly<typeof rawReviewShape.runtimeType>) {
    return {
        id: raw.id,
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        state: check.isEnumValue(raw.state, RawReviewState)
            ? reviewStates[raw.state]
            : GitHubReviewState.Commented,
        body: raw.body,
        bodyHtml: raw.bodyHTML,
        createdAt: raw.createdAt,
        url: raw.url,
    };
}

/**
 * Requests whose reviewer GitHub won't name — a deleted account, or a team the token can't see —
 * are dropped rather than rendered as a blank row.
 */
export function toReviewRequests(
    raw: ReadonlyArray<Readonly<typeof rawReviewRequestShape.runtimeType>>,
) {
    return raw
        .map((node) => {
            return {
                reviewer: node.requestedReviewer?.login || node.requestedReviewer?.name || '',
                reviewerAvatarUrl: node.requestedReviewer?.avatarUrl || '',
            };
        })
        .filter((request) => !!request.reviewer);
}

type RawCheckContext = typeof rawCheckContextShape.runtimeType;

const checkConverters: {
    [ContextType in RawCheckContextType]: (
        raw: Readonly<Extract<RawCheckContext, {__typename: ContextType}>>,
    ) => {
        name: string;
        workflow: string;
        state: GitHubCheckState;
        url: string;
        description: string;
    };
} = {
    /**
     * A run's verdict lives in `conclusion` once it finishes and is null while it runs, so an
     * unfinished run reads as pending regardless of its `status`.
     */
    [RawCheckContextType.CheckRun](raw) {
        return {
            name: raw.name,
            workflow: raw.checkSuite.workflowRun?.workflow.name || '',
            state: raw.conclusion ? checkResultStates[raw.conclusion] : GitHubCheckState.Pending,
            url: raw.detailsUrl || '',
            description: '',
        };
    },
    [RawCheckContextType.StatusContext](raw) {
        return {
            name: raw.context,
            workflow: '',
            state: checkResultStates[raw.state],
            url: raw.targetUrl || '',
            description: raw.description || '',
        };
    },
};

function toCheck(raw: Readonly<RawCheckContext>) {
    /** TypeScript can't pair each converter with its own union member through the index. */
    return (
        checkConverters[raw.__typename] satisfies (raw: any) => unknown as (
            raw: Readonly<RawCheckContext>,
        ) => ReturnType<(typeof checkConverters)[RawCheckContextType]>
    )(raw);
}

/**
 * Flatten one GraphQL PR node into the shape the pane consumes. Exported for tests: this is the
 * only part of the GitHub integration that can be exercised without a network call, and it's where
 * the enum translations and null-author fallbacks live.
 */
export function toPr(raw: Readonly<typeof rawPrShape.runtimeType>) {
    const graphqlState = prStates[raw.state];
    const rollup = raw.commits.nodes[0]?.commit.statusCheckRollup;
    return {
        id: raw.id,
        owner: raw.baseRepository?.owner.login || '',
        repoName: raw.baseRepository?.name || '',
        number: raw.number,
        url: raw.url,
        title: raw.title,
        titleHtml: raw.titleHTML,
        body: raw.body,
        bodyHtml: raw.bodyHTML,
        /** Draft isn't a GraphQL `state` — it's a flag on top of `OPEN`. */
        state:
            graphqlState === GitHubPrState.Open && raw.isDraft ? GitHubPrState.Draft : graphqlState,
        author: raw.author?.login || deletedAuthorLogin,
        authorAvatarUrl: raw.author?.avatarUrl || '',
        baseRefName: raw.baseRefName,
        headRefName: raw.headRefName,
        createdAt: raw.createdAt,
        checks: rollup ? checkResultStates[rollup.state] : GitHubCheckState.None,
        checkRuns: (rollup?.contexts.nodes || []).map(toCheck),
        reviews: raw.latestReviews.nodes.map(toReview),
        reviewRequests: toReviewRequests(raw.reviewRequests.nodes),
        threads: raw.reviewThreads.nodes.map(toThread),
        comments: raw.comments.nodes.map(toComment),
    };
}

/**
 * How long a fetched PR is served back without asking GitHub again. Matches the pane's own refresh
 * cadence, so re-opening the tab or switching folders back and forth costs nothing, while the
 * pane's timer still lands on a real query each time it fires.
 */
const prCacheTtl: AnyDuration = {
    minutes: 5,
};

/**
 * Last PR fetched per folder. Lives here rather than in the browser so every client — and a reload
 * — shares one GitHub rate-limit budget, and so a reopened tab paints without a round trip to
 * GitHub.
 */
const prCacheByFolder = new Map<
    string,
    {
        pr: ReturnType<typeof toPr> | null;
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
}>) {
    const cached = prCacheByFolder.get(folder);
    if (
        cached &&
        !forceRefresh &&
        Date.now() - cached.fetchedAt <
            convertDuration(prCacheTtl, {
                milliseconds: true,
            }).milliseconds
    ) {
        return cached.pr;
    }
    const pr = await queryFolderPr(folder);
    prCacheByFolder.set(folder, {
        pr,
        fetchedAt: Date.now(),
    });
    return pr;
}

async function queryFolderPr(folder: string) {
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
    const node = assertWrapValidShape(
        await runGraphql(prQuery, {
            owner: slug.owner,
            name: slug.name,
            branch,
        }),
        prQueryResponseShape,
    ).repository?.pullRequests.nodes[0];
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
}>) {
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
}>) {
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
}>) {
    await runGraphql(resolved ? resolveThreadMutation : unresolveThreadMutation, {
        threadId,
    });
}
