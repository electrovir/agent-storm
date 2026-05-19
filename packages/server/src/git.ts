import {runShellCommand} from '@augment-vir/node';
import {execFile} from 'node:child_process';
import {lstat, readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);

type GitInfo = {
    branch: string | null;
    dirty: boolean;
    unpushed: boolean;
};

const cleanGitInfo: GitInfo = {
    branch: null,
    dirty: false,
    unpushed: false,
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

    const hasUpstream = await runGit(folder, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
    ]).then((output) => output != undefined);

    const unpushed = hasUpstream
        ? await runGit(folder, [
              'log',
              '--oneline',
              '@{upstream}..HEAD',
          ]).then((output) => !!output && output.length > 0)
        : false;

    return {
        branch,
        dirty,
        unpushed,
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
            if (!childStat?.isDirectory()) {
                return undefined;
            } else if (await isBareGitRepo(childPath)) {
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
}>): Promise<void> {
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
}

export async function removeWorktree({
    worktreePath,
}: Readonly<{worktreePath: string}>): Promise<void> {
    const parent = join(worktreePath, '..');
    const children = await listWorktreeChildren(parent);
    const sibling = children.find((path) => path !== worktreePath);
    if (!sibling) {
        throw new Error(`Refusing to remove last worktree at ${worktreePath}.`);
    }
    await exec(
        'git',
        [
            'worktree',
            'remove',
            worktreePath,
            '--force',
        ],
        {
            cwd: sibling,
        },
    );
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
    merged: boolean;
};

export type GitHubPollingDisableReason = 'rate-limited' | 'unauthenticated';

/**
 * Thrown by `getPrInfo` when the `gh` invocation surfaces a rate-limit or auth failure. Callers use
 * this as a signal to stop making GitHub calls — both situations turn every subsequent `gh pr view`
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

const sevenDaysSeconds = 7 * 24 * 60 * 60;

export async function getPrInfo(folder: string, branch: string | null): Promise<PrInfo | null> {
    if (!branch || !(await isGhAvailable())) {
        return null;
    }
    /**
     * Single-quote the branch since `runShellCommand` invokes a shell and branch names can legally
     * contain `/`. Git rejects single quotes in refs anyway, but escape defensively.
     */
    const safeBranch = `'${branch.replace(/'/g, String.raw`'\''`)}'`;
    const result = await runShellCommand(`gh pr view ${safeBranch} --json url,state,mergedAt`, {
        cwd: folder,
    });
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
        /**
         * Benign failures (no PR for branch, repo not on GitHub, etc.) — `gh` exits non-zero with
         * no rate/auth markers, so treat as "no PR" and let the sweep continue.
         */
        return null;
    }
    const parsed = JSON.parse(result.stdout) as {
        url?: string;
        state?: string;
        mergedAt?: string | null;
    };
    if (parsed.state === 'CLOSED') {
        return null;
    } else if (!parsed.url) {
        return null;
    }
    const merged =
        parsed.state === 'MERGED' &&
        !!parsed.mergedAt &&
        (Date.now() - new Date(parsed.mergedAt).getTime()) / 1000 <= sevenDaysSeconds;
    return {
        url: parsed.url,
        merged,
    };
}
