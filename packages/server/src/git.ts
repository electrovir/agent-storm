import {GitHubPollingDisableReason, PrStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    convertByteSize,
    extractErrorMessage,
    log,
    removeDuplicates,
    wait,
    type AnyByteSize,
    type Overwrite,
} from '@augment-vir/common';
import {normalizePath, runCommand} from 'agent-storm';
import {
    calculateRelativeDate,
    convertDuration,
    getNowInUtcTimezone,
    maybeCreateFullDate,
    toTimestamp,
    utcTimezone,
    type AnyDuration,
} from 'date-vir';
import {lstat, mkdir, readdir, realpath, rename, rm, stat} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    parseJsonWithShape,
} from 'object-shape-tester';
import {deletingReviewFoldersDir} from './file-paths.js';
import {
    failedCheckResults,
    RawCheckResult,
    RawMergeState,
    RawPrState,
    RawReviewDecision,
    RawReviewState,
} from './github-raw-enums.js';
import {readManualReviewEntry, reviewBranchPrefix, toReviewFolder} from './manual-review-state.js';

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
    return (await getGitInfo(folder)).branch;
}

/**
 * Every folder's last-read git state, keyed by normalized path. Every read of a folder's branch,
 * dirty state, or push state goes through {@link getGitInfo}, so a read by any feature refreshes it
 * for all of them.
 */
const gitInfoStore = new Map<
    string,
    {
        info: GitInfo;
        readAtMs: number;
    }
>();
/** Reads in flight, so callers asking at the same time share one `git status`. */
const pendingGitInfoReads = new Map<string, Promise<GitInfo>>();

type GitInfoChange = {
    /** Normalized path. */
    folder: string;
    previous: GitInfo;
    info: GitInfo;
};

const gitInfoListeners = new Set<(change: Readonly<GitInfoChange>) => void>();

/**
 * Calls `listener` whenever a read finds a folder's git state changed, whichever feature did the
 * read. A folder's first read doesn't count.
 */
export function listenToGitInfoChanges(listener: (change: Readonly<GitInfoChange>) => void) {
    gitInfoListeners.add(listener);
}

/** Drops a folder that's no longer shown from the git state and slug stores. */
export function forgetGitInfo(folder: string) {
    gitInfoStore.delete(normalizePath(folder));
    repoSlugStore.delete(normalizePath(folder));
}

/**
 * The folder's branch, dirty state, and push state from the shared store, read from git first when
 * the stored copy is older than `maxAge`.
 */
export async function getGitInfo(
    folder: string,
    {
        maxAge = {
            seconds: 2,
        },
    }: Readonly<{
        maxAge?: AnyDuration | undefined;
    }> = {},
): Promise<GitInfo> {
    const key = normalizePath(folder);
    const stored = gitInfoStore.get(key);
    if (
        stored &&
        Date.now() - stored.readAtMs <
            convertDuration(maxAge, {
                milliseconds: true,
            }).milliseconds
    ) {
        return stored.info;
    }
    const pending =
        pendingGitInfoReads.get(key) ||
        readGitInfo(key).finally(() => pendingGitInfoReads.delete(key));
    pendingGitInfoReads.set(key, pending);
    return await pending;
}

async function readGitInfo(folder: string) {
    const info = await readGitInfoFromGit(folder);
    const previous = gitInfoStore.get(folder)?.info;
    gitInfoStore.set(folder, {
        info,
        readAtMs: Date.now(),
    });
    if (previous && !check.deepEquals(previous, info)) {
        gitInfoListeners.forEach((listener) => {
            listener({
                folder,
                previous,
                info,
            });
        });
    }
    return info;
}

async function readGitInfoFromGit(folder: string): Promise<GitInfo> {
    const status = await tryGit(folder, [
        'status',
        '--porcelain=v2',
        '--branch',
    ]);
    const lines = (status || '').split('\n').filter(Boolean);

    function readBranchHeader(name: string) {
        const prefix = `# branch.${name} `;
        return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
    }

    const branch = readBranchHeader('head');
    /** `(initial)` is a branch with no commits yet, which `rev-parse HEAD` can't resolve either. */
    if (!branch || branch === '(detached)' || readBranchHeader('oid') === '(initial)') {
        return cleanGitInfo;
    }
    /**
     * Missing when there's no upstream, and also when the upstream is configured but its remote
     * branch is gone. Both fall back to commits no remote has.
     */
    const aheadBehind = readBranchHeader('ab');
    const notPushed = aheadBehind
        ? !aheadBehind.startsWith('+0 ')
        : await tryGit(folder, [
              'rev-list',
              '--max-count=1',
              'HEAD',
              '--not',
              '--remotes',
          ]).then((output) => !!output?.trim());

    return {
        branch,
        dirty: lines.some((line) => !line.startsWith('#')),
        notPushed,
    };
}

/**
 * Environment for git calls that only read. `git status` otherwise takes `index.lock` to save the
 * stat info it refreshed, and while it holds it every write to the index in that checkout fails,
 * including the user staging a file and an agent committing. Required locks are unaffected.
 */
export const readOnlyGitEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
};

/**
 * Deadline for a git call that isn't expected to take long, including a `fetch`. Generous, because
 * it only exists so a network stall or a credential prompt can't hold a caller forever.
 */
export const gitTimeout: AnyDuration = {
    minutes: 2,
};

/**
 * The stderr of a failed {@link runCommand}, or the error's message when there's none (git missing,
 * a timeout).
 */
export function extractCommandStderr(error: unknown) {
    return (
        (check.isObject(error) && check.hasKey(error, 'stderr')
            ? String(error.stderr).trim()
            : '') || extractErrorMessage(error)
    );
}

/** Runs a read-only git command in `cwd`. Its stdout, or undefined when git fails for any reason. */
export async function tryGit(cwd: string, args: ReadonlyArray<string>) {
    const result = await runCommand('git', [...args], {
        cwd,
        env: readOnlyGitEnv,
        timeout: gitTimeout,
    }).catch(() => undefined);
    return result?.stdout;
}

/**
 * The checkout the PR of the folder's branch is being reviewed in, made by `/manual-review here` or
 * by the Review tab. Null when the folder isn't on a branch, the skill has no PR recorded for that
 * branch, or the review folder isn't a checkout yet.
 */
export async function findManualReviewCopy(folder: string) {
    const [
        branch,
        slug,
    ] = await Promise.all([
        getCurrentBranch(folder),
        getRepoSlug(folder),
    ]);
    if (!branch || !slug) {
        return null;
    }
    const prNumber = (
        await readManualReviewEntry({
            owner: slug.owner,
            repoName: slug.name,
            branchName: branch,
        })
    )?.prNumber;
    if (!prNumber) {
        return null;
    }
    const copy = toReviewFolder({
        owner: slug.owner,
        repoName: slug.name,
        number: prNumber,
    });
    return (await tryGit(copy, [
        'rev-parse',
        '--git-dir',
    ])) == undefined
        ? null
        : copy;
}

/**
 * Whether the folder is a copy `/manual-review here` made, which `run-here.sh` marks with a
 * `<reviewer name>-review-pr` note in the copy's git dir. A review the Review tab started lives at
 * the same kind of path but has no note.
 */
export async function isManualReviewHereCopy(folder: string) {
    const gitDir = (
        await tryGit(folder, [
            'rev-parse',
            '--absolute-git-dir',
        ])
    )?.trim();
    return (
        !!gitDir &&
        (await readdir(gitDir).catch(() => [])).some((name) => name.endsWith('-review-pr'))
    );
}

/** The folder's visible subfolders that hold a `.git`, file or folder alike. */
async function findChildCheckouts(folder: string) {
    const entries = await readdir(folder).catch(() => []);
    const checkouts = await Promise.all(
        entries.map(async (name) => {
            if (name.startsWith('.')) {
                return undefined;
            }
            const path = join(folder, name);
            const childStat = await stat(path).catch(() => undefined);
            const dotGitPath = join(path, '.git');
            const dotGitStat = childStat?.isDirectory()
                ? await lstat(dotGitPath).catch(() => undefined)
                : undefined;
            return dotGitStat
                ? {
                      path,
                      dotGitPath,
                      dotGitStat,
                  }
                : undefined;
        }),
    );
    return checkouts.filter(check.isTruthy);
}

export async function isWorktreeRoot(folder: string): Promise<boolean> {
    const checks = await Promise.all(
        (await findChildCheckouts(folder)).map(async ({dotGitPath, dotGitStat}) => {
            if (dotGitStat.isFile()) {
                return true;
            } else if (dotGitStat.isDirectory()) {
                const worktreesStat = await stat(join(dotGitPath, 'worktrees')).catch(
                    () => undefined,
                );
                return worktreesStat?.isDirectory() || false;
            } else {
                return false;
            }
        }),
    );
    return checks.includes(true);
}

export async function listWorktreeChildren(folder: string): Promise<string[]> {
    const results = await Promise.all(
        (await findChildCheckouts(folder)).map(async ({path}) => {
            return (await isBareGitRepo(path)) ? undefined : path;
        }),
    );
    return results.filter(check.isTruthy);
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

/**
 * Create `name` as a sibling of the repo's existing worktrees. A worktree left behind by an earlier
 * attempt (the server restarted mid-checkout, say) is adopted instead of failing on "already
 * exists".
 */
export async function addWorktree({
    repoPath,
    name,
}: Readonly<{
    repoPath: string;
    name: string;
}>): Promise<{worktreePath: string}> {
    const children = await listWorktreeChildren(repoPath);
    /** Skip the target itself, which an earlier attempt may have already created. */
    const anyChild = children.find((child) => basename(child) !== name);
    if (!anyChild) {
        throw new Error(`No existing worktree found in ${repoPath} to base a new worktree on.`);
    }
    const worktreePath = join(dirname(anyChild), name);
    const existing = await findRegisteredWorktree({
        cwd: anyChild,
        worktreePath,
    });
    if (existing?.isInitializing) {
        throw new Error(
            `${worktreePath} is still being checked out by an earlier attempt. Try again once it finishes.`,
        );
    } else if (!existing) {
        await runCommand(
            'git',
            [
                'worktree',
                'add',
                `../${name}`,
            ],
            {
                cwd: anyChild,
                /** Checks out the whole tree, which takes a while in a big repo. */
                timeout: {
                    minutes: 10,
                },
            },
        );
    }
    return {
        worktreePath,
    };
}

const worktreeLinePrefix = 'worktree ';

/**
 * Undefined when git has no worktree registered at `worktreePath`. `git worktree add` locks a new
 * worktree with the reason `initializing` until its checkout finishes, which is what
 * `isInitializing` reports.
 */
async function findRegisteredWorktree({
    cwd,
    worktreePath,
}: Readonly<{
    cwd: string;
    worktreePath: string;
}>): Promise<{isInitializing: boolean} | undefined> {
    const realWorktreePath = await realpath(worktreePath).catch(() => undefined);
    if (!realWorktreePath) {
        return undefined;
    }
    const output = await tryGit(cwd, [
        'worktree',
        'list',
        '--porcelain',
    ]);
    const entryLines = output
        ?.split('\n\n')
        .map((entry) => entry.split('\n'))
        .find((lines) => {
            const [firstLine] = lines;
            /** Git prints `/` separators even on Windows, where Node's paths use `\\`. */
            return (
                !!firstLine?.startsWith(worktreeLinePrefix) &&
                normalizePath(firstLine.slice(worktreeLinePrefix.length)) === realWorktreePath
            );
        });
    return entryLines
        ? {
              isInitializing: entryLines.includes('locked initializing'),
          }
        : undefined;
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
    /** {@link listWorktreeChildren} skips hidden folders. */
    const movedPath = await moveAside({
        folder: worktreePath,
        deletingDir: join(parent, '.agent-storm-deleting'),
    });
    await runRemoveWorktree({
        cwd: sibling,
        worktreePath,
    });
    await deleteMovedFolder({
        folder: worktreePath,
        movedPath,
    });
    await runCommand(
        'git',
        [
            'worktree',
            'prune',
        ],
        {
            cwd: sibling,
            timeout: gitTimeout,
        },
    ).catch(() => undefined);
}

/**
 * Deleting a checkout file by file (`git worktree remove` or `rm -rf`) takes several seconds for a
 * big `node_modules`, and the folder keeps showing up until it finishes. A rename is instant, so
 * the folder gets moved out of sight first and git only drops its record of the missing folder.
 *
 * Undefined when the move fails, such as across volumes.
 */
async function moveAside({folder, deletingDir}: Readonly<{folder: string; deletingDir: string}>) {
    const movedPath = join(deletingDir, `${basename(folder)}-${Date.now()}`);
    return await mkdir(deletingDir, {
        recursive: true,
    })
        .then(async () => await rename(folder, movedPath))
        .then(
            () => movedPath,
            () => undefined,
        );
}

/** Deletes a folder moved by {@link moveAside} in the background, or `folder` in place otherwise. */
async function deleteMovedFolder({
    folder,
    movedPath,
}: Readonly<{folder: string; movedPath: string | undefined}>) {
    const deletion = rm(movedPath || folder, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 250,
    });
    if (movedPath) {
        void deletion.catch((error: unknown) => {
            log.warning(`Failed to delete ${movedPath}: ${extractErrorMessage(error)}`);
        });
    } else {
        await deletion;
    }
}

async function runRemoveWorktree({
    cwd,
    worktreePath,
}: Readonly<{
    cwd: string;
    worktreePath: string;
}>): Promise<void> {
    const firstError = await runCommand(
        'git',
        [
            'worktree',
            'remove',
            '--force',
            worktreePath,
        ],
        {
            cwd,
            timeout: gitTimeout,
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

    /** The folder itself is deleted either way; a failure here only leaves git's record behind. */
    await runCommand(
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
            timeout: gitTimeout,
        },
    ).catch((error: unknown) => {
        log.warning(
            `git worktree remove failed for ${worktreePath}: ${extractCommandStderr(error)}`,
        );
    });
}

/**
 * Deletes a review folder along with its `review__` branch. Unlike {@link removeWorktree}, it also
 * handles a folder that's a full clone, the last worktree of its repo, or no checkout at all.
 */
export async function deleteReviewFolder(folder: string) {
    const isCheckout = !!(await lstat(join(folder, '.git')).catch(() => undefined));
    const [
        commonDir,
        branch,
    ] = isCheckout
        ? await Promise.all([
              tryGit(folder, [
                  'rev-parse',
                  '--path-format=absolute',
                  '--git-common-dir',
              ]),
              tryGit(folder, [
                  'branch',
                  '--show-current',
              ]),
          ])
        : [];
    const gitDir = commonDir?.trim();
    const movedPath = await moveAside({
        folder,
        deletingDir: deletingReviewFoldersDir,
    });
    if (gitDir) {
        await tryGit(gitDir, [
            '--git-dir',
            gitDir,
            'worktree',
            'remove',
            '--force',
            '--force',
            folder,
        ]);
    }
    await deleteMovedFolder({
        folder,
        movedPath,
    });
    if (!gitDir) {
        return;
    }
    await tryGit(gitDir, [
        '--git-dir',
        gitDir,
        'worktree',
        'prune',
    ]);
    const reviewBranch = branch?.trim();
    if (reviewBranch?.startsWith(reviewBranchPrefix)) {
        await tryGit(gitDir, [
            '--git-dir',
            gitDir,
            'branch',
            '-D',
            reviewBranch,
        ]);
    }
}

/**
 * Deletes what {@link deleteReviewFolder} moved aside but didn't finish deleting before the server
 * stopped.
 */
export async function sweepDeletingReviewFolders() {
    const names = await readdir(deletingReviewFoldersDir).catch(() => []);
    await Promise.all(
        names.map(async (name) => {
            const path = join(deletingReviewFoldersDir, name);
            await rm(path, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 250,
            }).catch((error: unknown) => {
                log.warning(`Failed to delete ${path}: ${extractErrorMessage(error)}`);
            });
        }),
    );
}

/** Only a positive answer is kept, so running `gh auth login` after startup is noticed. */
const ghAvailability: {isAvailable: boolean} = {
    isAvailable: false,
};

export async function isGhAvailable(): Promise<boolean> {
    if (!ghAvailability.isAvailable) {
        ghAvailability.isAvailable = await runCommand(
            'gh',
            [
                'auth',
                'status',
            ],
            {
                timeout: ghTimeout,
            },
        ).then(
            () => true,
            () => false,
        );
    }
    return ghAvailability.isAvailable;
}

export const prInfoShape = defineShape({
    url: '',
    /**
     * Never {@link PrStatus.None}. Merged and closed PRs only appear within
     * {@link terminalPrDisplayWindow}; older ones are dropped from the response entirely.
     */
    status: enumShape(PrStatus),
});

export type PrInfo = typeof prInfoShape.runtimeType;

export type RepoSlug = {
    owner: string;
    name: string;
};

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
        /** When GitHub says polling can resume. Undefined when GitHub's answer couldn't be read. */
        public readonly resumeAtMs?: number | undefined,
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

/**
 * GitHub's docs say to wait at least this long after a secondary rate limit that sends no
 * `retry-after` header, which `gh` never shows us anyway.
 */
const secondaryRateLimitWait: AnyDuration = {
    minutes: 1,
};

/**
 * When GitHub's GraphQL budget refills, read from `gh api rate_limit`, which doesn't spend any of
 * that budget. A rate-limit error with points still remaining is a secondary limit, which has no
 * reset time to read. Undefined when the budget can't be read.
 */
async function readRateLimitResumeAtMs(): Promise<number | undefined> {
    const result = await runGh([
        'api',
        'rate_limit',
        '--jq',
        '.resources.graphql',
    ]);
    if (result.exitCode !== 0) {
        return undefined;
    }
    try {
        const graphql = parseJsonWithShape(
            result.stdout,
            defineShape({
                remaining: 0,
                /** Unix seconds. */
                reset: 0,
            }),
        );
        return graphql.remaining
            ? toTimestamp(calculateRelativeDate(getNowInUtcTimezone(), secondaryRateLimitWait))
            : graphql.reset * 1000;
    } catch {
        return undefined;
    }
}

/** How long a merged or closed PR keeps its branch's "this branch had a PR" marker. */
const terminalPrDisplayWindow: AnyDuration = {
    days: 7,
};

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
/**
 * Every folder's GitHub slug, keyed by normalized path. A slug is kept for good, since `origin`
 * only changes by hand. A folder without one is asked again after {@link missingSlugRecheck},
 * because a checkout can still be cloned into it.
 */
const repoSlugStore = new Map<
    string,
    {
        slug: RepoSlug | null;
        readAtMs: number;
    }
>();
const missingSlugRecheck: AnyDuration = {
    minutes: 2,
};

export async function getRepoSlug(folder: string): Promise<RepoSlug | null> {
    const key = normalizePath(folder);
    const stored = repoSlugStore.get(key);
    if (
        stored &&
        (stored.slug ||
            Date.now() - stored.readAtMs <
                convertDuration(missingSlugRecheck, {
                    milliseconds: true,
                }).milliseconds)
    ) {
        return stored.slug;
    }
    const output = await tryGit(key, [
        'remote',
        'get-url',
        'origin',
    ]);
    const slug = output ? parseGithubRemote(output) : null;
    repoSlugStore.set(key, {
        slug,
        readAtMs: Date.now(),
    });
    return slug;
}

/**
 * Open PRs and terminal (closed / merged) PRs are two separate connections rather than one `states:
 * [OPEN, CLOSED, MERGED]` list, because a single ordered list lets merge churn push a still-open PR
 * off the end: a repo where twenty PRs merged this week would return zero open ones, and every
 * worktree branch would silently lose its sidebar marker.
 *
 * Both connections are fetched in one call. GitHub charges by how many nested lists the query could
 * return, so each open PR's nested lists count against the open-PR cap: past this cap the query
 * costs 2 points instead of 1.
 */
const openPrsBatchSize = 70;
/** Terminal PRs only feed the "recently merged" marker, so a short list is plenty. */
const terminalPrsBatchSize = 20;

const terminalPrNodeFields = [
    '      nodes {',
    '        url',
    '        headRefName',
    '        state',
    '        closedAt',
    '      }',
].join('\n');

const openPrNodeFields = [
    '      nodes {',
    '        url',
    '        headRefName',
    '        state',
    '        mergeStateStatus',
    '        reviewDecision',
    '        body',
    '        author { login }',
    /** Not `commits(last: 1)`, which is a nested list and takes the query from 1 point to 2. */
    '        headRef { target { ... on Commit { statusCheckRollup { state } } } }',
    '        latestOpinionatedReviews(first: 20) { nodes { state viewerDidAuthor author { login } } }',
    '        viewerLatestReviewRequest { id }',
    '        viewerDidAuthor',
    '        reviewThreads(first: 100) { nodes { isResolved } }',
    '      }',
].join('\n');

const repoPrsGraphqlQuery = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    open: pullRequests(states: [OPEN], first: ${openPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    openPrNodeFields,
    '    }',
    `    terminal: pullRequests(states: [CLOSED, MERGED], first: ${terminalPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    terminalPrNodeFields,
    '    }',
    '  }',
    '}',
].join('\n');

/** One node of {@link terminalPrNodeFields}. */
const terminalPrNodeShape = defineShape({
    url: '',
    headRefName: '',
    state: enumShape(RawPrState),
    closedAt: nullableShape(''),
});

/** One node of {@link openPrNodeFields}. */
const openPrNodeShape = defineShape({
    url: '',
    headRefName: '',
    state: enumShape(RawPrState),
    mergeStateStatus: '',
    reviewDecision: nullableShape(''),
    body: '',
    author: nullableShape({
        login: '',
    }),
    headRef: nullableShape({
        /** Empty when the branch points at something other than a commit. */
        target: nullableShape({
            statusCheckRollup: optionalShape(
                nullableShape({
                    state: '',
                }),
            ),
        }),
    }),
    latestOpinionatedReviews: {
        nodes: [
            {
                state: '',
                viewerDidAuthor: false,
                author: nullableShape({
                    login: '',
                }),
            },
        ],
    },
    viewerLatestReviewRequest: nullableShape({
        id: '',
    }),
    viewerDidAuthor: false,
    reviewThreads: {
        nodes: [
            {
                isResolved: false,
            },
        ],
    },
});

export type OpenPrNode = typeof openPrNodeShape.runtimeType;

const repoPrsResponseShape = defineShape({
    data: {
        /** Null when GitHub has no such repository, or the viewer can't see it. */
        repository: nullableShape({
            open: {
                nodes: [
                    openPrNodeShape,
                ],
            },
            terminal: {
                nodes: [
                    terminalPrNodeShape,
                ],
            },
        }),
    },
});

/** The verdict each review state gives. Undefined still awaits one. */
const viewerReviewPrStatuses: Readonly<Record<RawReviewState, PrStatus | undefined>> = {
    [RawReviewState.Approved]: PrStatus.Approved,
    [RawReviewState.ChangesRequested]: PrStatus.ChangesRequested,
    [RawReviewState.Commented]: undefined,
    [RawReviewState.Dismissed]: undefined,
    [RawReviewState.Pending]: undefined,
};

/**
 * Review-vir's `parseInsertedCodeOwners`: the logins pull-request-vir lists in the code owners
 * block it writes into a PR's raw markdown body. `undefined` when there's no block.
 */
export function parseInsertedCodeOwners(body: string) {
    const block = /<!-- code owners start -->([\S\s]*?)<!-- code owners end -->/i.exec(body)?.[1];
    if (block == undefined) {
        return undefined;
    }
    /** Owned-file link lines are dropped so scoped paths (`@types/...`) aren't read as owners. */
    const ownerLines = block
        .split('\n')
        .filter((line) => !/^\s*-\s/.test(line))
        .join('\n');
    return removeDuplicates(
        Array.from(ownerLines.matchAll(/@[\w-]+/g)).map((tag) => tag[0].slice(1)),
    );
}

/**
 * GitHub drops the viewer's review request once they submit a review, so a request that exists
 * means they never reviewed it or were asked to look again.
 *
 * Reads `latestOpinionatedReviews` rather than `viewerLatestReview`: replying to a review thread
 * files a comment-only review, which `viewerLatestReview` would return in place of an approval.
 */
export function toOpenPrStatus({
    mergeStateStatus,
    reviewDecision,
    body,
    author,
    headRef,
    latestOpinionatedReviews,
    viewerLatestReviewRequest,
    viewerDidAuthor,
    reviewThreads,
}: Readonly<
    Overwrite<
        Pick<
            OpenPrNode,
            | 'mergeStateStatus'
            | 'reviewDecision'
            | 'body'
            | 'author'
            | 'headRef'
            | 'viewerLatestReviewRequest'
            | 'viewerDidAuthor'
        >,
        {
            latestOpinionatedReviews: Readonly<{
                nodes: ReadonlyArray<OpenPrNode['latestOpinionatedReviews']['nodes'][number]>;
            }>;
            reviewThreads: Readonly<{
                nodes: ReadonlyArray<OpenPrNode['reviewThreads']['nodes'][number]>;
            }>;
        }
    >
>) {
    const reviews = latestOpinionatedReviews.nodes;
    const viewerReviewState = reviews.find((review) => review.viewerDidAuthor)?.state;
    /** GitHub doesn't let a PR's author approve or request changes on it. */
    const viewerVerdict =
        !viewerDidAuthor && check.isEnumValue(viewerReviewState, RawReviewState)
            ? viewerReviewPrStatuses[viewerReviewState]
            : undefined;
    const rollupState = headRef?.target?.statusCheckRollup?.state;
    const hasUnresolvedThread = reviewThreads.nodes.some((thread) => !thread.isResolved);
    const isViewerSignedOff = viewerDidAuthor || viewerVerdict === PrStatus.Approved;
    const isViewerDone = isViewerSignedOff && !hasUnresolvedThread;
    /** Pull-request-vir skips the author's own rules and counts only approvals. */
    const hasUnapprovedCodeOwner = (parseInsertedCodeOwners(body) || []).some((owner) => {
        return (
            owner.toLowerCase() !== author?.login.toLowerCase() &&
            !reviews.some((review) => {
                return (
                    review.state === RawReviewState.Approved &&
                    review.author?.login.toLowerCase() === owner.toLowerCase()
                );
            })
        );
    });
    /**
     * `CLEAN` only means GitHub would allow the merge, which it does with the viewer's review
     * request still open when the repo doesn't require reviews.
     */
    if (viewerLatestReviewRequest) {
        return viewerVerdict === PrStatus.ChangesRequested
            ? PrStatus.ReReviewRequested
            : PrStatus.AwaitingReview;
    } else if (mergeStateStatus === RawMergeState.Clean) {
        return PrStatus.ReadyToMerge;
    } else if (
        isViewerSignedOff &&
        reviews.some((review) => {
            return !review.viewerDidAuthor && review.state === RawReviewState.ChangesRequested;
        })
    ) {
        return PrStatus.OthersRequestedChanges;
    } else if (
        isViewerDone &&
        /**
         * Pull-request-vir enforces code-owner review with a CI check rather than GitHub's own
         * rule, which leaves `reviewDecision` at `APPROVED` while a code owner still hasn't.
         */
        (reviewDecision === RawReviewDecision.ReviewRequired || hasUnapprovedCodeOwner)
    ) {
        return PrStatus.AwaitingOtherReviews;
    } else if (
        isViewerDone &&
        check.isEnumValue(rollupState, RawCheckResult) &&
        failedCheckResults[rollupState]
    ) {
        return PrStatus.ChecksFailed;
    } else if (viewerVerdict === PrStatus.ChangesRequested) {
        return viewerVerdict;
    } else {
        return hasUnresolvedThread
            ? PrStatus.UnresolvedComments
            : viewerVerdict || PrStatus.AwaitingReview;
    }
}

export type GhExecResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

/** Deadline for one `gh` call. A timed-out call fails like any other. */
const ghTimeout: AnyDuration = {
    minutes: 1,
};

/**
 * Node's 1 MB default cuts off big GraphQL answers, such as a PR with many long review threads,
 * which then fail as unparsable JSON.
 */
const ghMaxBuffer: AnyByteSize = {
    megabytes: 50,
};

export async function runGh(args: ReadonlyArray<string>): Promise<GhExecResult> {
    try {
        const result = await runCommand('gh', [...args], {
            maxBuffer: convertByteSize(ghMaxBuffer, {
                bytes: true,
            }).bytes,
            timeout: ghTimeout,
        });
        return {
            exitCode: 0,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    } catch (error) {
        return {
            exitCode:
                check.isObject(error) && check.hasKey(error, 'code') && check.isNumber(error.code)
                    ? error.code
                    : 1,
            stdout:
                check.isObject(error) && check.hasKey(error, 'stdout') ? String(error.stdout) : '',
            stderr: extractCommandStderr(error),
        };
    }
}

/**
 * Fetch a single repo's open PRs, plus the terminal ones within {@link terminalPrDisplayWindow}, in
 * one GraphQL call. Returns a `Map<headRefName, PrInfo>` so callers can resolve a folder's branch
 * to its PR with an O(1) lookup, no further API traffic. Older terminal-state PRs (closed/merged)
 * are dropped from the returned map so they don't show stale "this branch had a PR" markers in the
 * UI.
 *
 * Throws {@link GitHubPollingError} on rate-limit or auth failure so the caller can flip the polling
 * kill-switch instead of retrying immediately. Other failures (no `gh`, repo not on GitHub, network
 * blip, a timeout, an answer that doesn't match the query) return `undefined`, so the caller keeps
 * what it already knows instead of treating the repo as having no PRs.
 */
export async function fetchRepoPrs(
    slug: Readonly<RepoSlug>,
): Promise<Map<string, PrInfo> | undefined> {
    if (!(await isGhAvailable())) {
        return undefined;
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
                GitHubPollingDisableReason.RateLimited,
                `GitHub API rate limit hit: ${result.stderr.trim()}`,
                await readRateLimitResumeAtMs(),
            );
        } else if (looksUnauthenticated(result.stderr)) {
            throw new GitHubPollingError(
                GitHubPollingDisableReason.Unauthenticated,
                `GitHub authentication failed: ${result.stderr.trim()}`,
            );
        } else {
            return undefined;
        }
    }
    try {
        return parsePrsByBranch(result.stdout);
    } catch (error) {
        log.warning(
            `Unreadable PR list for ${slug.owner}/${slug.name}: ${extractErrorMessage(error)}`,
        );
        return undefined;
    }
}

/**
 * {@link buildPrsByBranch} over the raw answer to {@link repoPrsGraphqlQuery}. Throws when the answer
 * doesn't match the query.
 */
export function parsePrsByBranch(graphqlOutput: string) {
    const repository = parseJsonWithShape(graphqlOutput, repoPrsResponseShape).data.repository;
    return buildPrsByBranch({
        openNodes: repository?.open.nodes || [],
        terminalNodes: repository?.terminal.nodes || [],
    });
}

/**
 * How each PR state reads in the sidebar. Undefined for an open PR, whose status depends on
 * reviews.
 */
const terminalPrStatuses: Readonly<Record<RawPrState, PrStatus | undefined>> = {
    [RawPrState.Open]: undefined,
    [RawPrState.Closed]: PrStatus.Closed,
    [RawPrState.Merged]: PrStatus.Merged,
};

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
    openNodes: ReadonlyArray<Readonly<OpenPrNode>>;
    terminalNodes: ReadonlyArray<Readonly<typeof terminalPrNodeShape.runtimeType>>;
}>): Map<string, PrInfo> {
    const cutoff =
        Date.now() -
        convertDuration(terminalPrDisplayWindow, {
            milliseconds: true,
        }).milliseconds;
    const map = new Map<string, PrInfo>();
    openNodes.forEach((node) => {
        if (!node.url || !node.headRefName || map.has(node.headRefName)) {
            return;
        }
        map.set(node.headRefName, {
            url: node.url,
            status: terminalPrStatuses[node.state] || toOpenPrStatus(node),
        });
    });
    terminalNodes.forEach((node) => {
        const status = terminalPrStatuses[node.state];
        /** Terminal PRs past the window would show a stale "this branch had a PR" marker. */
        const closedAt = maybeCreateFullDate(node.closedAt, utcTimezone);
        if (
            !node.url ||
            !node.headRefName ||
            map.has(node.headRefName) ||
            !status ||
            !closedAt ||
            toTimestamp(closedAt) < cutoff
        ) {
            return;
        }
        map.set(node.headRefName, {
            url: node.url,
            status,
        });
    });
    return map;
}
