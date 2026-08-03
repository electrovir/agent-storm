import {wait} from '@augment-vir/common';
import {maybeCreateFullDate, toTimestamp, utcTimezone} from 'date-vir';
import {execFile} from 'node:child_process';
import {lstat, readdir, rm, stat} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

type GitInfo = {
    branch: string | null;
    dirty: boolean;
    notPushed: boolean;
};

const cleanGitInfo: GitInfo = {
    branch: null,
    dirty: false,
    notPushed: false,
};

/**
 * The folder's checked-out branch, or null when it isn't a git checkout or is on a detached HEAD
 * (which has no branch name to match a PR against).
 */
export async function getCurrentBranch(folder: string): Promise<string | null> {
    const branch = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
    ]).then((output) => output?.trim() || null);
    return !branch || branch === 'HEAD' ? null : branch;
}

export async function getGitInfo(folder: string): Promise<GitInfo> {
    const branch = await getCurrentBranch(folder);

    if (!branch) {
        return cleanGitInfo;
    }

    const status = await runGit(folder, [
        'status',
        '--porcelain',
    ]);
    const dirty = !!status && status.length > 0;

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
    };
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
            } else {
                return false;
            }
        }),
    );
    return checks.includes(true);
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
    /**
     * True when the PR is merged or closed (and within the 7-day display window — older
     * terminal-state PRs are dropped from the response entirely, so this is never true for stale
     * data). False for still-open PRs, including drafts.
     */
    closed: boolean;
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
 * Open PRs and terminal (closed / merged) PRs are two separate connections rather than one `states:
 * [OPEN, CLOSED, MERGED]` list, because a single ordered list lets merge churn push a still-open PR
 * off the end: a repo where twenty PRs merged this week would return zero open ones, and every
 * worktree branch would silently lose its sidebar marker.
 *
 * Both connections are fetched in one call. GitHub charges this query 1 point either way — the
 * GraphQL cost formula divides total nodes by 100 and floors at 1 — so the open-PR cap costs
 * nothing to raise and is set high enough to cover every branch a user could have worktrees
 * against.
 */
const openPrsBatchSize = 100;
/** Terminal PRs are only used for the 7-day "recently merged" marker, so a short list is plenty. */
const terminalPrsBatchSize = 20;

const prNodeFields = [
    '      nodes {',
    '        url',
    '        headRefName',
    '        state',
    '        closedAt',
    '      }',
].join('\n');

const repoPrsGraphqlQuery = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    open: pullRequests(states: [OPEN], first: ${openPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    prNodeFields,
    '    }',
    `    terminal: pullRequests(states: [CLOSED, MERGED], first: ${terminalPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    prNodeFields,
    '    }',
    '  }',
    '}',
].join('\n');

export type RawPrNode = {
    url?: string;
    headRefName?: string;
    state?: string;
    closedAt?: string | null;
};

export type GhExecResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

export async function runGh(args: ReadonlyArray<string>): Promise<GhExecResult> {
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
        } else {
            /** Benign (repo not on GitHub, network blip, etc.) — treat as "no PRs known" for now. */
            return new Map();
        }
    }
    const parsed = JSON.parse(result.stdout) as {
        data?: {
            repository?: {
                open?: {nodes?: ReadonlyArray<RawPrNode>};
                terminal?: {nodes?: ReadonlyArray<RawPrNode>};
            };
        };
    };
    return buildPrsByBranch({
        openNodes: parsed.data?.repository?.open?.nodes || [],
        terminalNodes: parsed.data?.repository?.terminal?.nodes || [],
    });
}

/**
 * Collapse both PR connections into one branch → PR lookup. Open PRs are walked first so a branch
 * that has both an open PR and an older closed one keeps the open one, whatever their update times.
 * Within each list, nodes arrive ordered by `UPDATED_AT` descending and first wins.
 *
 * Exported for tests — everything above it in {@link fetchRepoPrs} needs a live `gh`.
 */
export function buildPrsByBranch({
    openNodes,
    terminalNodes,
}: Readonly<{
    openNodes: ReadonlyArray<RawPrNode>;
    terminalNodes: ReadonlyArray<RawPrNode>;
}>): Map<string, PrInfo> {
    const cutoff = Date.now() - sevenDaysMs;
    const map = new Map<string, PrInfo>();
    [
        ...openNodes,
        ...terminalNodes,
    ].forEach((node) => {
        if (!node.url || !node.headRefName || map.has(node.headRefName)) {
            return;
        }
        const isTerminal = node.state === 'CLOSED' || node.state === 'MERGED';
        if (!isTerminal && node.state !== 'OPEN') {
            return;
        }
        if (isTerminal) {
            /** Terminal PRs past the window would show a stale "this branch had a PR" marker. */
            const closedAt = maybeCreateFullDate(node.closedAt, utcTimezone);
            if (!closedAt || toTimestamp(closedAt) < cutoff) {
                return;
            }
        }
        map.set(node.headRefName, {
            url: node.url,
            closed: isTerminal,
        });
    });
    return map;
}
