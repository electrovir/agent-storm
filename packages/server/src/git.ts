import {RepoInspectionState, type RepoInspection} from '@agent-storm/common';
import {log, wait} from '@augment-vir/common';
import {runShellCommand} from '@augment-vir/node';
import {execFile} from 'node:child_process';
import {lstat, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

type GitInfo = {
    branch: string | null;
    dirty: boolean;
    notPushed: boolean;
    /** Short HEAD SHA (`rev-parse HEAD`); null for detached / not-a-repo. */
    localCommitHash: string | null;
};

const cleanGitInfo: GitInfo = {
    branch: null,
    dirty: false,
    notPushed: false,
    localCommitHash: null,
};

export async function getGitInfo(folder: string): Promise<GitInfo> {
    const branch = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]).then((output) => output?.trim() || null);

    if (!branch || branch === 'HEAD') {
        return cleanGitInfo;
    }

    const status = await runGit(folder, [
        'status',
        '--porcelain',
    ]);
    const dirty = !!status && status.length > 0;

    const localCommitHash = await runGit(folder, [
        'rev-parse',
        'HEAD',
    ]).then((output) => output?.trim() || null);

    const hasUpstream = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
    ]).then((output) => output != undefined);

    const notPushed = hasUpstream
        ? await runGit(folder, [
              'log',
              '--oneline',
              '@{upstream}..HEAD',
          ]).then((output) => !!output && output.length > 0)
        : false;

    return {
        branch,
        dirty,
        notPushed,
        localCommitHash,
    };
}

/**
 * Just the checked-out branch name — one git subprocess instead of `getGitInfo`'s five. Reconcile
 * only needs the branch (to compute `isBase`), and it runs for every worktree at the top of every
 * sweep, so the difference is hundreds of subprocess spawns per minute on many-worktree setups.
 */
export async function getGitBranch(folder: string): Promise<string | null> {
    const branch = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]).then((output) => output?.trim() || null);
    return !branch || branch === 'HEAD' ? null : branch;
}

export async function hasUncommittedChanges(folder: string): Promise<boolean> {
    const status = await runGit(folder, [
        'status',
        '--porcelain',
    ]);
    return !!status && status.length > 0;
}

async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<string | undefined> {
    const result = await exec('git', [...args], {
        cwd,
    }).catch(() => undefined);
    return result?.stdout;
}

export async function isWorktreeRoot(folder: string): Promise<boolean> {
    const entries = await readdir(folder).catch(() => []);
    const checks = await Promise.all(
        entries.map(async (name) => {
            if (name.startsWith('.')) {
                return false;
            }
            const childPath = join(folder, name);
            const childStat = await stat(childPath).catch(() => undefined);
            if (!childStat?.isDirectory()) {
                return false;
            }
            const dotGit = join(childPath, '.git');
            const dotGitStat = await lstat(dotGit).catch(() => undefined);
            if (!dotGitStat) {
                return false;
            } else if (dotGitStat.isFile()) {
                return true;
            } else if (dotGitStat.isDirectory()) {
                const worktreesDir = join(dotGit, 'worktrees');
                const worktreesStat = await stat(worktreesDir).catch(() => undefined);
                return worktreesStat?.isDirectory() || false;
            }
            return false;
        }),
    );
    return checks.some((isWorktree) => isWorktree);
}

export async function listWorktreeChildren(folder: string): Promise<string[]> {
    const entries = await readdir(folder).catch(() => []);
    const results = await Promise.all(
        entries.map(async (name) => {
            if (name.startsWith('.')) {
                return undefined;
            }
            const childPath = join(folder, name);
            const childStat = await stat(childPath).catch(() => undefined);
            if (!childStat?.isDirectory() || (await isBareGitRepo(childPath))) {
                return undefined;
            }
            const dotGit = join(childPath, '.git');
            const dotGitStat = await lstat(dotGit).catch(() => undefined);
            return dotGitStat ? childPath : undefined;
        }),
    );
    return results.filter((path): path is string => !!path);
}

async function isBareGitRepo(folder: string): Promise<boolean> {
    const [
        headStat,
        refsStat,
        objectsStat,
    ] = await Promise.all([
        stat(join(folder, 'HEAD')).catch(() => undefined),
        stat(join(folder, 'refs')).catch(() => undefined),
        stat(join(folder, 'objects')).catch(() => undefined),
    ]);
    return !!headStat?.isFile() && !!refsStat?.isDirectory() && !!objectsStat?.isDirectory();
}

export async function addWorktree({
    repoPath,
    name,
}: Readonly<{
    repoPath: string;
    name: string;
}>): Promise<{worktreePath: string}> {
    const children = await listWorktreeChildren(repoPath);
    const anyChild = children[0];
    if (!anyChild) {
        throw new Error(`No existing worktree found in ${repoPath} to base a new worktree on.`);
    }
    await exec(
        'git',
        [
            'worktree',
            'add',
            `../${name}`,
        ],
        {
            cwd: anyChild,
        },
    );
    return {
        worktreePath: join(dirname(anyChild), name),
    };
}

export async function removeWorktree({
    worktreePath,
}: Readonly<{worktreePath: string}>): Promise<void> {
    const parent = dirname(worktreePath);
    const children = await listWorktreeChildren(parent);
    const sibling = children.find((path) => path !== worktreePath);
    if (!sibling) {
        throw new Error(`Refusing to remove last worktree at ${worktreePath}.`);
    }
    await runRemoveWorktree({
        cwd: sibling,
        worktreePath,
    });
    await rm(worktreePath, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 250,
    });
    await exec(
        'git',
        [
            'worktree',
            'prune',
        ],
        {
            cwd: sibling,
        },
    ).catch(() => undefined);
}

async function runRemoveWorktree({
    cwd,
    worktreePath,
}: Readonly<{
    cwd: string;
    worktreePath: string;
}>): Promise<void> {
    const firstError = await exec(
        'git',
        [
            'worktree',
            'remove',
            '--force',
            worktreePath,
        ],
        {
            cwd,
        },
    )
        .then(() => undefined)
        .catch((error: unknown) => error);

    if (!firstError) {
        return;
    }
    await wait({
        milliseconds: 250,
    });

    const secondError = await exec(
        'git',
        [
            'worktree',
            'remove',
            '--force',
            '--force',
            worktreePath,
        ],
        {
            cwd,
        },
    )
        .then(() => undefined)
        .catch((error: unknown) => error);

    if (!secondError) {
        return;
    }
}

let cachedGhAvailable: boolean | undefined;

async function isGhAvailable(): Promise<boolean> {
    if (cachedGhAvailable != undefined) {
        return cachedGhAvailable;
    }
    cachedGhAvailable = await exec('gh', [
        'auth',
        'status',
    ])
        .then(() => true)
        .catch(() => false);
    return cachedGhAvailable;
}

export type PrInfo = {
    url: string;
    /** True when the PR is merged. */
    merged: boolean;
    /** True when the PR is in draft state. */
    isDraft: boolean;
    /** Remote head SHA. Empty string when unavailable. */
    headRefOid: string;
    /**
     * Aggregated CI result: true if every check finished successfully, false if any failed, null
     * while checks are still pending or no checks have been registered yet.
     */
    ciPassing: boolean | null;
    /** True when at least one CI check is currently running. */
    ciInProgress: boolean;
    /** True when GitHub's `reviewDecision` is APPROVED. */
    approved: boolean;
    /**
     * True when at least one reviewer's current verdict is "changes requested" — excluding
     * reviewers who have since been re-requested. See {@link hasActiveChangesRequested}.
     */
    reviewChangesRequested: boolean;
    /** True when reviewers have been requested but haven't yet weighed in. */
    reviewPending: boolean;
    /** True when at least one inline review thread is still unresolved. */
    hasUnresolvedReviewComments: boolean;
    /**
     * Aggregated result of review-flavoured status checks. Null when none exist or all are still
     * running.
     */
    reviewCheckPassing: boolean | null;
    /** True while at least one review-flavoured check is still running. */
    reviewCheckInProgress: boolean;
    /**
     * True when GitHub reports the PR's `mergeable` state as `CONFLICTING` — the branch can't be
     * merged without resolving conflicts against the base. `UNKNOWN` (GitHub still computing) and
     * `MERGEABLE` both map to false so a transient unknown doesn't flash a false block.
     */
    hasMergeConflicts: boolean;
};

export type RepoSlug = {
    owner: string;
    name: string;
};

export type GitHubPollingDisableReason = 'rate-limited' | 'unauthenticated';

/**
 * Thrown by {@link fetchRepoPrs} when `gh` surfaces a rate-limit or auth failure. Callers use this
 * as a signal to stop making GitHub calls — both situations turn every subsequent GraphQL request
 * into wasted overhead until the user intervenes (or, for rate limits, the window resets).
 */
export class GitHubPollingError extends Error {
    public override readonly name = 'GitHubPollingError';
    constructor(
        public readonly reason: GitHubPollingDisableReason,
        message: string,
    ) {
        super(message);
    }
}

/**
 * Rate-limit detection on `gh`'s stderr.
 *
 * GitHub itself authoritatively signals rate limits three ways.
 *
 * 1. HTTP `429 Too Many Requests`.
 * 2. HTTP `403 Forbidden` with `x-ratelimit-remaining: 0` (primary rate limit hit).
 * 3. A GraphQL error body with `type: "RATE_LIMIT"` or `code: "graphql_rate_limit"` (secondary /
 *    GraphQL-specific limits).
 *
 * `gh` only surfaces the HTTP status line and the API's `message` field on stderr — never the
 * response headers — so the `x-ratelimit-remaining: 0` signal isn't visible to us. We instead match
 * on what `gh` actually prints: the literal `HTTP 429` / `HTTP 403` status, the API's "API rate
 * limit exceeded" message, secondary-limit phrasing, and the GraphQL `RATE_LIMIT` error type that
 * bleeds through when the error gets printed verbatim.
 */
function looksRateLimited(stderr: string): boolean {
    return (
        /rate[\s_-]?limit/i.test(stderr) ||
        /HTTP\s+429\b/i.test(stderr) ||
        /\bRATE_LIMIT(?:ED)?\b/.test(stderr) ||
        /graphql_rate_limit/i.test(stderr)
    );
}

/**
 * Auth-failure detection on `gh`'s stderr. GitHub returns HTTP 401 for bad/expired tokens and HTTP
 * 403 with messages like "Bad credentials" or "Resource not accessible by ..." for scope issues.
 * `gh` itself bails out with hints like "gh auth login" when it can't find a token at all. Catch
 * all of these.
 */
function looksUnauthenticated(stderr: string): boolean {
    return /\b(authenticate|authentication|bad credentials|unauthorized|http 401|gh auth login)\b/i.test(
        stderr,
    );
}

const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Match the three GitHub remote URL shapes we expect to see in a developer's `.git/config`:
 *
 * - SCP-style SSH: `git@github.com:owner/name(.git)?`
 * - `ssh://` URL form: `ssh://git@github.com/owner/name(.git)?`
 * - HTTPS (with optional `user:token@` basic-auth prefix): `https://github.com/owner/name(.git)?`
 *
 * Non-GitHub remotes (custom GHE hosts, GitLab, Bitbucket, etc.) intentionally don't match — PRs
 * are a github.com concept here, so we return null and skip the repo.
 */
const githubRemotePatterns: ReadonlyArray<RegExp> = [
    /^[^@\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/[^@\s]+@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^https?:\/\/(?:[^/@\s]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
];

function parseGithubRemote(url: string): RepoSlug | null {
    const trimmed = url.trim();
    if (!trimmed) {
        return null;
    }
    const match = githubRemotePatterns
        .map((pattern) => pattern.exec(trimmed))
        .find((candidate) => !!candidate?.[1] && !!candidate[2]);
    if (!match) {
        return null;
    }
    return {
        owner: match[1] || '',
        name: match[2] || '',
    };
}

/**
 * Resolve the `owner/name` slug for a folder's `origin` remote. Local-only — no API call — because
 * this only needs to read `.git/config` via `git remote get-url origin`. Returns null if the folder
 * has no `origin`, the remote points somewhere other than github.com, or the URL doesn't parse.
 */
export async function getRepoSlug(folder: string): Promise<RepoSlug | null> {
    const output = await runGit(folder, [
        'remote',
        'get-url',
        'origin',
    ]);
    if (!output) {
        return null;
    }
    return parseGithubRemote(output);
}

/**
 * GraphQL query: fetch up to {@link fetchRepoPrsBatchSize} of a repo's most-recently-updated PRs
 * across all states. Variables (`$owner`, `$name`) are passed via `gh api`'s `-f` so the query
 * itself stays constant and the cost-per-call is bounded by node count, keeping us well under the
 * GraphQL hourly point budget.
 */
/**
 * Upper bound on PRs returned per repo per call. Picked at the GraphQL ceiling of 100 because the
 * empirical cost per call (~2-5 points for nested reviewThreads + statusCheckRollup connections) is
 * trivial against the 5000-points/hour primary rate limit, and every PR we surface in the batch is
 * one less worktree that has to fall back to a `gh pr view` subprocess. With many worktrees on
 * older branches, those per-branch fallbacks were the dominant source of sweep latency and
 * rate-limit pressure — pulling more PRs in the single batch eliminates most of them.
 */
const fetchRepoPrsBatchSize = 100;

const repoPrsGraphqlQuery = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    pullRequests(states: [OPEN, CLOSED, MERGED], first: ${fetchRepoPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    '      nodes {',
    '        url',
    '        headRefName',
    '        headRefOid',
    '        state',
    '        closedAt',
    '        mergedAt',
    '        isDraft',
    '        mergeable',
    '        reviewDecision',
    '        latestReviews(first: 20) { nodes { state author { login } } }',
    '        reviewRequests(first: 20) { totalCount nodes { requestedReviewer { __typename ... on User { login } } } }',
    '        reviewThreads(first: 25) { nodes { isResolved isOutdated } }',
    '        commits(last: 1) { nodes { commit { statusCheckRollup {',
    '          contexts(first: 30) { nodes {',
    '            __typename',
    '            ... on CheckRun { name status conclusion }',
    '            ... on StatusContext { context state }',
    '          } }',
    '        } } } }',
    '      }',
    '    }',
    '  }',
    '}',
].join('\n');

type RawCheckRollupContext = {
    __typename?: string;
    name?: string;
    status?: string;
    conclusion?: string;
    context?: string;
    state?: string;
};

type RawPrNode = {
    url?: string;
    headRefName?: string;
    headRefOid?: string;
    state?: string;
    closedAt?: string | null;
    mergedAt?: string | null;
    isDraft?: boolean;
    mergeable?: string | null;
    reviewDecision?: string | null;
    latestReviews?: {
        nodes?: ReadonlyArray<{
            state?: string | null;
            author?: {login?: string | null} | null;
        }>;
    };
    reviewRequests?: {
        totalCount?: number;
        nodes?: ReadonlyArray<{
            requestedReviewer?: {login?: string | null} | null;
        }>;
    };
    reviewThreads?: {
        nodes?: ReadonlyArray<{
            isResolved?: boolean;
            isOutdated?: boolean;
        }>;
    };
    commits?: {
        nodes?: ReadonlyArray<{
            commit?: {
                statusCheckRollup?: {
                    contexts?: {
                        nodes?: ReadonlyArray<RawCheckRollupContext>;
                    };
                } | null;
            };
        }>;
    };
};

/**
 * Identifies checks that represent code review (Claude review, reviewdog, etc.) rather than
 * build/lint/format/test CI. The "Pass CI" progress step ignores these — code review has its own
 * dedicated step ("Get approval") and a pending or failed review shouldn't make the CI step look
 * red.
 */
const reviewCheckPattern = /review/i;

function isReviewCheck(check: Readonly<RawCheckRollupContext>): boolean {
    const label = check.name || check.context || '';
    return reviewCheckPattern.test(label);
}

type LatestReview = {
    state?: string | null;
    author?: {login?: string | null} | null;
};

/**
 * True iff at least one reviewer's _current_ effective verdict is "changes requested". A reviewer
 * counts only when their most-recent review requested changes AND they have not since been
 * re-requested.
 *
 * GitHub's `reviewDecision` stays stuck on `CHANGES_REQUESTED` even after the author re-requests
 * the reviewer — and the stale review keeps showing up in `latestReviews` — so neither signal alone
 * can tell "still blocked" from "waiting on a fresh re-review". Re-requesting the reviewer re-adds
 * them to `reviewRequests`, so a login that appears there means their old changes-requested verdict
 * is no longer current and shouldn't flag the PR red.
 */
export function hasActiveChangesRequested(
    latestReviews: ReadonlyArray<LatestReview>,
    reRequestedLogins: ReadonlySet<string>,
): boolean {
    return latestReviews.some(
        (review) =>
            review.state === 'CHANGES_REQUESTED' &&
            !(review.author?.login != null && reRequestedLogins.has(review.author.login)),
    );
}

const failureConclusions = new Set([
    'FAILURE',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STALE',
]);
const successConclusions = new Set([
    'SUCCESS',
    'NEUTRAL',
    'SKIPPED',
]);

function summarizeStatusCheckRollup(checks: ReadonlyArray<RawCheckRollupContext> | undefined): {
    passing: boolean | null;
    inProgress: boolean;
} {
    if (!checks || checks.length === 0) {
        return {passing: null, inProgress: false};
    }
    let pending = false;
    for (const check of checks) {
        const conclusion = check.conclusion?.toUpperCase() || '';
        const status = check.status?.toUpperCase() || '';
        const commitState = check.state?.toUpperCase() || '';
        if (
            failureConclusions.has(conclusion) ||
            commitState === 'FAILURE' ||
            commitState === 'ERROR'
        ) {
            return {passing: false, inProgress: false};
        }
        if (status && status !== 'COMPLETED') {
            pending = true;
        } else if (commitState === 'PENDING' || commitState === 'EXPECTED') {
            pending = true;
        } else if (conclusion && !successConclusions.has(conclusion)) {
            pending = true;
        } else if (!conclusion && !commitState) {
            pending = true;
        }
    }
    return {
        passing: pending ? null : true,
        inProgress: pending,
    };
}

type GhExecResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

async function runGh(args: ReadonlyArray<string>): Promise<GhExecResult> {
    try {
        const result = await exec('gh', [...args]);
        return {
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    } catch (caught) {
        const error = caught as {
            code?: number | string;
            stdout?: string;
            stderr?: string;
        };
        return {
            exitCode: typeof error.code === 'number' ? error.code : 1,
            stdout: error.stdout || '',
            stderr: error.stderr || '',
        };
    }
}

/**
 * Fetch the recent open + (terminal within 7 days) PRs for a single repo in one GraphQL call.
 * Returns a `Map<headRefName, PrInfo>` so callers can resolve a folder's branch to its PR with an
 * O(1) lookup, no further API traffic. Terminal-state PRs (closed/merged) older than 7 days are
 * dropped from the returned map so they don't show stale "this branch had a PR" markers in the UI.
 *
 * Throws {@link GitHubPollingError} on rate-limit or auth failure so the caller can flip the polling
 * kill-switch instead of retrying immediately. Other failure modes (network, repo doesn't exist,
 * etc.) return an empty map and let the sweep proceed.
 */
export async function fetchRepoPrs(slug: Readonly<RepoSlug>): Promise<Map<string, PrInfo>> {
    if (!(await isGhAvailable())) {
        return new Map();
    }
    const result = await runGh([
        'api',
        'graphql',
        '-f',
        `query=${repoPrsGraphqlQuery}`,
        '-f',
        `owner=${slug.owner}`,
        '-f',
        `name=${slug.name}`,
    ]);
    if (result.exitCode !== 0) {
        if (looksRateLimited(result.stderr)) {
            throw new GitHubPollingError(
                'rate-limited',
                `GitHub API rate limit hit: ${result.stderr.trim()}`,
            );
        } else if (looksUnauthenticated(result.stderr)) {
            throw new GitHubPollingError(
                'unauthenticated',
                `GitHub authentication failed: ${result.stderr.trim()}`,
            );
        }
        /** Benign (repo not on GitHub, network blip, etc.) — treat as "no PRs known" for now. */
        return new Map();
    }
    const parsed = JSON.parse(result.stdout) as {
        data?: {
            repository?: {
                pullRequests?: {
                    nodes?: ReadonlyArray<RawPrNode>;
                };
            };
        };
    };
    const nodes = parsed.data?.repository?.pullRequests?.nodes || [];
    const cutoff = Date.now() - sevenDaysMs;
    const map = new Map<string, PrInfo>();
    nodes.forEach((node) => {
        if (!node.url || !node.headRefName) {
            return;
        }
        const isOpen = node.state === 'OPEN';
        const isTerminal = node.state === 'CLOSED' || node.state === 'MERGED';
        if (!isOpen && !isTerminal) {
            return;
        }
        if (isTerminal) {
            const closedAtMs = node.closedAt ? new Date(node.closedAt).getTime() : NaN;
            if (!Number.isFinite(closedAtMs) || closedAtMs < cutoff) {
                return;
            }
        }
        /**
         * Nodes arrive ordered by UPDATED_AT DESC; first-wins so we keep the most-recent PR for a
         * given branch when GitHub has more than one (e.g. a closed PR re-created against the same
         * branch).
         */
        if (!map.has(node.headRefName)) {
            const allChecks =
                node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
            const buildChecks = allChecks.filter((check) => !isReviewCheck(check));
            const reviewChecks = allChecks.filter((check) => isReviewCheck(check));
            const ciStatus = summarizeStatusCheckRollup(buildChecks);
            const reviewCheckStatus = summarizeStatusCheckRollup(reviewChecks);
            const reviewDecision = node.reviewDecision ?? '';
            const reviewRequestsCount = node.reviewRequests?.totalCount ?? 0;
            const reRequestedLogins = new Set(
                (node.reviewRequests?.nodes ?? [])
                    .map((request) => request.requestedReviewer?.login)
                    .filter((login): login is string => !!login),
            );
            const reviewThreadNodes = node.reviewThreads?.nodes ?? [];
            // Outdated threads point at code that no longer exists in the diff — the reviewer's
            // concern is moot regardless of whether anyone clicked "Resolve conversation".
            const hasUnresolvedReviewComments = reviewThreadNodes.some(
                (thread) => thread.isResolved === false && thread.isOutdated !== true,
            );
            map.set(node.headRefName, {
                url: node.url,
                merged: node.state === 'MERGED',
                isDraft: !!node.isDraft,
                headRefOid: node.headRefOid || '',
                ciPassing: ciStatus.passing,
                ciInProgress: ciStatus.inProgress,
                approved: reviewDecision === 'APPROVED',
                // Per-reviewer "currently blocking" — re-requested reviewers are excluded even
                // though GitHub leaves `reviewDecision` stuck on CHANGES_REQUESTED. See
                // `hasActiveChangesRequested`.
                reviewChangesRequested: hasActiveChangesRequested(
                    node.latestReviews?.nodes ?? [],
                    reRequestedLogins,
                ),
                // Only flag pending when there's an outstanding human action. PRs without
                // required reviewers report `reviewDecision: ''` and shouldn't light up the
                // approval step as loading forever.
                reviewPending: reviewDecision === 'REVIEW_REQUIRED' && reviewRequestsCount > 0,
                hasUnresolvedReviewComments,
                reviewCheckPassing: reviewCheckStatus.passing,
                reviewCheckInProgress: reviewCheckStatus.inProgress,
                hasMergeConflicts: node.mergeable === 'CONFLICTING',
            });
        }
    });
    return map;
}

/**
 * Per-branch PR lookup for branches the batch `fetchRepoPrs` missed (e.g. the branch's PR predates
 * the 100 most-recently-updated PRs in the repo). Uses `gh pr view` against a single branch —
 * cheaper than expanding the batch query, and only triggered for cache misses, so a repo where
 * every active worktree matches a recent PR pays nothing extra.
 *
 * Returns null when there is no PR for the branch, or when the lookup hits a benign failure
 * (network blip, repo not on GitHub, etc.). Rate-limit / auth failures bubble up so the outer cache
 * layer can flip the kill-switch.
 */
export async function fetchPrInfoForBranch(folder: string, branch: string): Promise<PrInfo | null> {
    if (!(await isGhAvailable())) {
        return null;
    }
    const safeBranch = `'${branch.replace(/'/g, String.raw`'\''`)}'`;
    /**
     * `gh pr view --json` exposes `statusCheckRollup`, `reviewDecision`, `reviewRequests`, etc. but
     * NOT `reviewThreads` — that's only reachable via raw GraphQL. The fallback path is rare
     * (worktree against a PR older than the batch window) so we accept the small accuracy loss on
     * `hasUnresolvedReviewComments` here rather than running a second per-branch GraphQL call.
     */
    const result = await runShellCommand(
        `gh pr view ${safeBranch} --json url,state,mergedAt,isDraft,mergeable,headRefOid,statusCheckRollup,reviewDecision,latestReviews,reviewRequests`,
        {cwd: folder},
    );
    if (result.exitCode !== 0) {
        if (looksRateLimited(result.stderr)) {
            throw new GitHubPollingError(
                'rate-limited',
                `GitHub API rate limit hit (pr view): ${result.stderr.trim()}`,
            );
        } else if (looksUnauthenticated(result.stderr)) {
            throw new GitHubPollingError(
                'unauthenticated',
                `GitHub authentication failed (pr view): ${result.stderr.trim()}`,
            );
        }
        return null;
    }
    let parsed: {
        url?: string;
        state?: string;
        mergedAt?: string | null;
        isDraft?: boolean;
        mergeable?: string | null;
        headRefOid?: string;
        statusCheckRollup?: ReadonlyArray<RawCheckRollupContext>;
        reviewDecision?: string | null;
        latestReviews?: ReadonlyArray<{
            state?: string | null;
            author?: {login?: string | null} | null;
        }>;
        reviewRequests?: ReadonlyArray<{login?: string | null}>;
    };
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        return null;
    }
    if (!parsed.url || parsed.state === 'CLOSED') {
        return null;
    }
    const allChecks = parsed.statusCheckRollup ?? [];
    const buildChecks = allChecks.filter((check) => !isReviewCheck(check));
    const reviewChecks = allChecks.filter((check) => isReviewCheck(check));
    const ciStatus = summarizeStatusCheckRollup(buildChecks);
    const reviewCheckStatus = summarizeStatusCheckRollup(reviewChecks);
    const reviewDecision = parsed.reviewDecision ?? '';
    const reviewRequestsCount = parsed.reviewRequests?.length ?? 0;
    const reRequestedLogins = new Set(
        (parsed.reviewRequests ?? [])
            .map((request) => request.login)
            .filter((login): login is string => !!login),
    );
    return {
        url: parsed.url,
        merged: parsed.state === 'MERGED',
        isDraft: !!parsed.isDraft,
        headRefOid: parsed.headRefOid || '',
        ciPassing: ciStatus.passing,
        ciInProgress: ciStatus.inProgress,
        approved: reviewDecision === 'APPROVED',
        // See `hasActiveChangesRequested` — re-requested reviewers don't count even though
        // GitHub leaves `reviewDecision` stuck on CHANGES_REQUESTED.
        reviewChangesRequested: hasActiveChangesRequested(
            parsed.latestReviews ?? [],
            reRequestedLogins,
        ),
        reviewPending: reviewDecision === 'REVIEW_REQUIRED' && reviewRequestsCount > 0,
        // `gh pr view --json` doesn't expose reviewThreads, so this stays false on the fallback
        // path. Live data for branches in the batch window comes through the full GraphQL query
        // in `fetchRepoPrs`.
        hasUnresolvedReviewComments: false,
        reviewCheckPassing: reviewCheckStatus.passing,
        reviewCheckInProgress: reviewCheckStatus.inProgress,
        hasMergeConflicts: parsed.mergeable === 'CONFLICTING',
    };
}

export async function inspectRepoPath(folder: string): Promise<RepoInspection> {
    const folderStat = await stat(folder).catch(() => undefined);
    if (!folderStat?.isDirectory()) {
        return {
            state: RepoInspectionState.Empty,
            currentBranch: null,
            workingTreeClean: true,
            branches: [],
            worktreeRoot: null,
        };
    }

    const entries = await readdir(folder).catch(() => []);
    if (entries.length === 0) {
        return {
            state: RepoInspectionState.Empty,
            currentBranch: null,
            workingTreeClean: true,
            branches: [],
            worktreeRoot: null,
        };
    } else if (await isWorktreeRoot(folder)) {
        const children = await listWorktreeChildren(folder);
        const branches = (
            await Promise.all(
                children.map((child) => getGitInfo(child).then((info) => info.branch)),
            )
        ).filter((branch): branch is string => !!branch);
        return {
            state: RepoInspectionState.Worktree,
            currentBranch: null,
            workingTreeClean: true,
            branches,
            worktreeRoot: null,
        };
    }

    const dotGit = join(folder, '.git');
    const dotGitStat = await lstat(dotGit).catch(() => undefined);

    // If the picked folder is itself a worktree (.git is a pointer file, not a directory) and
    // its parent is a worktree-style repo root, treat the parent as the registerable repo and
    // the picked folder's branch as the chosen base branch — no picker needed.
    if (dotGitStat?.isFile()) {
        const parent = dirname(folder);
        if (parent !== folder && (await isWorktreeRoot(parent))) {
            const info = await getGitInfo(folder);
            const children = await listWorktreeChildren(parent);
            const branches = (
                await Promise.all(
                    children.map((child) =>
                        getGitInfo(child).then((childInfo) => childInfo.branch),
                    ),
                )
            ).filter((branch): branch is string => !!branch);
            return {
                state: RepoInspectionState.WorktreeChild,
                currentBranch: info.branch,
                workingTreeClean: !info.dirty,
                branches,
                worktreeRoot: parent,
            };
        }
    }

    if (!dotGitStat?.isDirectory()) {
        return {
            state: RepoInspectionState.NotARepo,
            currentBranch: null,
            workingTreeClean: false,
            branches: [],
            worktreeRoot: null,
        };
    }

    const info = await getGitInfo(folder);
    return {
        state: RepoInspectionState.Regular,
        currentBranch: info.branch,
        workingTreeClean: !info.dirty,
        branches: info.branch ? [info.branch] : [],
        worktreeRoot: null,
    };
}

export async function convertRepoToWorktreeLayout(folder: string): Promise<void> {
    const inspection = await inspectRepoPath(folder);
    if (inspection.state !== RepoInspectionState.Regular) {
        throw new Error(
            `Cannot convert ${folder}: expected a regular git repository (got "${inspection.state}").`,
        );
    } else if (!inspection.currentBranch) {
        throw new Error(
            `Cannot convert ${folder}: repository is in a detached HEAD state. Check out a branch first.`,
        );
    } else if (!inspection.workingTreeClean) {
        throw new Error(
            `Cannot convert ${folder}: working tree has uncommitted changes or untracked files. Commit or remove them first.`,
        );
    }

    const branch = inspection.currentBranch;
    const branchFolderName = branch.replace(/[/\\]/g, '-');
    const bareDir = join(folder, '.bare');
    const dotGitFile = join(folder, '.git');
    const newWorktreeDir = join(folder, branchFolderName);

    const bareExists = await lstat(bareDir).catch(() => undefined);
    if (bareExists) {
        throw new Error(`Cannot convert ${folder}: ".bare" already exists.`);
    }
    const branchFolderExists = await lstat(newWorktreeDir).catch(() => undefined);
    if (branchFolderExists) {
        throw new Error(
            `Cannot convert ${folder}: "${branchFolderName}" already exists at the repo root.`,
        );
    }

    await rename(join(folder, '.git'), bareDir);
    await exec('git', [
        '--git-dir',
        bareDir,
        'config',
        'core.bare',
        'true',
    ]);
    await exec('git', [
        '--git-dir',
        bareDir,
        'config',
        '--unset',
        'core.worktree',
    ]).catch(() => undefined);
    await writeFile(dotGitFile, 'gitdir: ./.bare\n');

    // `git worktree add` refuses to attach to a pre-existing directory, so register the worktree
    // first (this creates `newWorktreeDir` with only a `.git` pointer file inside) and then move
    // the original working tree contents into it.
    await exec(
        'git',
        [
            '--git-dir',
            bareDir,
            'worktree',
            'add',
            '--no-checkout',
            newWorktreeDir,
            branch,
        ],
        {
            cwd: folder,
        },
    );

    const remainingEntries = (await readdir(folder)).filter(
        (name) => name !== '.git' && name !== '.bare' && name !== branchFolderName,
    );
    for (const name of remainingEntries) {
        await rename(join(folder, name), join(newWorktreeDir, name));
    }

    // `--no-checkout` leaves the new worktree's index empty, which would make every file in the
    // working tree look both "deleted" and "untracked". Populate the index from HEAD so the
    // existing (clean) working tree matches it.
    await exec(
        'git',
        [
            'reset',
            '--mixed',
            'HEAD',
        ],
        {
            cwd: newWorktreeDir,
        },
    );
}
