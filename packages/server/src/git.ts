import {
    GitHubPollingDisableReason,
    openPrNodeShape,
    PrStatus,
    RawPrState,
    toOpenPrStatus,
    type OpenPrNode,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    awaitedBlockingMap,
    extractErrorMessage,
    log,
    mapObjectValuesSync,
    wait,
} from '@augment-vir/common';
import {
    deleteMovedFolder,
    extractCommandStderr,
    ghTimeout,
    gitTimeout,
    looksRateLimited,
    moveAside,
    normalizePath,
    packGraphqlParts,
    runCommand,
    runGh,
    tryGit,
} from 'agent-storm-util';
import {
    calculateRelativeDate,
    convertDuration,
    getNowInUtcTimezone,
    maybeCreateFullDate,
    toTimestamp,
    utcTimezone,
    type AnyDuration,
} from 'date-vir';
import {createHash} from 'node:crypto';
import {lstat, readdir, realpath, stat} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {
    defineShape,
    enumShape,
    nullableShape,
    parseJsonWithShape,
    recordShape,
} from 'object-shape-tester';
import {repoCacheKey} from './branch-prs.js';

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
 * read. A folder's first read doesn't count. Returns a function that stops listening.
 */
export function listenToGitInfoChanges(listener: (change: Readonly<GitInfoChange>) => void) {
    gitInfoListeners.add(listener);
    return () => {
        gitInfoListeners.delete(listener);
    };
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
 * Create `name` as a sibling of the repo's existing worktrees, branched from `baseCheckout` when
 * given, else from any of them. A worktree left behind by an earlier attempt (the server restarted
 * mid-checkout, say) is adopted instead of failing on "already exists".
 */
export async function addWorktree({
    repoPath,
    name,
    baseCheckout,
}: Readonly<{
    repoPath: string;
    name: string;
    baseCheckout?: string | undefined;
}>): Promise<{worktreePath: string}> {
    /** Skip the target itself, which an earlier attempt may have already created. */
    const sourceCheckout =
        baseCheckout ||
        (await listWorktreeChildren(repoPath)).find((child) => basename(child) !== name);
    if (!sourceCheckout) {
        throw new Error(`No existing worktree found in ${repoPath} to base a new worktree on.`);
    }
    const worktreePath = join(dirname(sourceCheckout), name);
    const existing = await findRegisteredWorktree({
        cwd: sourceCheckout,
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
                cwd: sourceCheckout,
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
 * When GitHub's GraphQL budget refills, read from the headers of the response that turned the
 * request away: `gh api rate_limit` can report a different GraphQL budget than the one that did. A
 * rate-limit error with points still remaining is a secondary limit, which has no reset time to
 * read. Undefined when the headers don't say.
 */
function readRateLimitResumeAtMs(headers: string) {
    const remaining = /^x-ratelimit-remaining:\s*(\d+)/im.exec(headers)?.[1];
    const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(headers)?.[1];
    if (remaining == undefined || reset == undefined) {
        return undefined;
    }
    return Number(remaining)
        ? toTimestamp(calculateRelativeDate(getNowInUtcTimezone(), secondaryRateLimitWait))
        : Number(reset) * 1000;
}

/**
 * When GitHub's used-up budgets refill, read from `gh api rate_limit`, which spends no budget. With
 * no budget used up the limit was a secondary one, which has no reset time to read. Undefined when
 * GitHub can't be asked.
 */
export async function fetchRateLimitResumeAtMs() {
    const result = await runGh([
        'api',
        'rate_limit',
        '--jq',
        '[.resources.core, .resources.graphql] | map(select(.remaining == 0) | .reset) | max',
    ]);
    if (result.exitCode !== 0) {
        return undefined;
    }
    const latestReset = Number(result.stdout.trim());
    return latestReset
        ? latestReset * 1000
        : toTimestamp(calculateRelativeDate(getNowInUtcTimezone(), secondaryRateLimitWait));
}

/**
 * Splits what `gh api --include` printed into the response headers and the body. Output without a
 * status line, as when `gh` fails before reaching GitHub, is all body.
 */
function splitIncludedHeaders(stdout: string) {
    const headerEnd = /\r?\n\r?\n/.exec(stdout);
    return stdout.startsWith('HTTP/') && headerEnd
        ? {
              headers: stdout.slice(0, headerEnd.index),
              body: stdout.slice(headerEnd.index + headerEnd[0].length),
          }
        : {
              headers: '',
              body: stdout,
          };
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
/**
 * Room in a repo's open-PR list, past its count at the last lookup, for PRs opened since. A repo
 * that outgrows it anyway is asked again with the full list.
 */
const newOpenPrAllowance = 5;

/**
 * Each repo's open PR count at its last lookup, by {@link repoCacheKey}. A shorter open-PR list
 * costs fewer requests, which leaves room for more repos in the same 1-point call.
 */
const openPrCountByRepo = new Map<string, number>();

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
    '        headRefOid',
    '        updatedAt',
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

/** One aliased `repository`, `repo<index>`, per open-PR limit, so a group of repos shares one call. */
function buildRepoPrsQuery(openPrLimits: ReadonlyArray<number>) {
    return [
        `query(${openPrLimits
            .map((_openPrLimit, index) => `$owner${index}: String!, $name${index}: String!`)
            .join(', ')}) {`,
        ...openPrLimits.flatMap((openPrLimit, index) => {
            return [
                `  repo${index}: repository(owner: $owner${index}, name: $name${index}) {`,
                `    open: pullRequests(states: [OPEN], first: ${openPrLimit}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
                '      pageInfo { hasNextPage }',
                openPrNodeFields,
                '    }',
                `    terminal: pullRequests(states: [CLOSED, MERGED], first: ${terminalPrsBatchSize}, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
                terminalPrNodeFields,
                '    }',
                '  }',
            ];
        }),
        '}',
    ].join('\n');
}

/** One node of {@link terminalPrNodeFields}. */
const terminalPrNodeShape = defineShape({
    url: '',
    headRefName: '',
    state: enumShape(RawPrState),
    closedAt: nullableShape(''),
});

const repoPrsResponseShape = defineShape({
    /** Keyed by the query's `repo<index>` aliases. Missing when GitHub answered none of them. */
    data: nullableShape(
        recordShape({
            keys: '',
            /** Null when GitHub has no such repository, or the viewer can't see it. */
            values: nullableShape({
                open: {
                    pageInfo: {
                        hasNextPage: false,
                    },
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
        }),
    ),
});

type RepoPrsRequest = {
    slug: Readonly<RepoSlug>;
    openPrLimit: number;
};

/**
 * Fetch repos' open PRs, plus the terminal ones within {@link terminalPrDisplayWindow}, in as few
 * GraphQL calls as fit in a point each. Answers each repo's `Map<headRefName, PrInfo>` by
 * {@link repoCacheKey}, so callers can resolve a folder's branch to its PR with no further API
 * traffic. Older terminal-state PRs (closed/merged) are dropped from the returned maps so they
 * don't show stale "this branch had a PR" markers in the UI.
 *
 * Throws {@link GitHubPollingError} on rate-limit or auth failure so the caller can flip the polling
 * kill-switch instead of retrying immediately. A repo that fails any other way (no `gh`, repo not
 * on GitHub, network blip, a timeout, an answer that doesn't match the query) is left out, so the
 * caller keeps what it already knows instead of treating the repo as having no PRs.
 */
export async function fetchRepoPrs(slugs: ReadonlyArray<Readonly<RepoSlug>>) {
    if (!(await isGhAvailable())) {
        return new Map<string, RepoPrsAnswer>();
    }
    const requests = slugs.map((slug) => {
        return {
            slug,
            openPrLimit: Math.min(
                openPrsBatchSize,
                (openPrCountByRepo.get(repoCacheKey(slug)) ?? openPrsBatchSize) +
                    newOpenPrAllowance,
            ),
        };
    });
    const trimmedAnswers = await fetchRepoPrGroups(requests);
    const fullAnswers = await fetchRepoPrGroups(
        requests
            .filter((request) => {
                return (
                    request.openPrLimit < openPrsBatchSize &&
                    trimmedAnswers.get(repoCacheKey(request.slug))?.hasMoreOpenPrs
                );
            })
            .map((request) => {
                return {
                    ...request,
                    openPrLimit: openPrsBatchSize,
                };
            }),
    );
    const answers = new Map([
        ...trimmedAnswers,
        ...fullAnswers,
    ]);
    answers.forEach((answer, key) => {
        openPrCountByRepo.set(key, answer.openPrCount);
    });
    return answers;
}

/** Each answered repo by {@link repoCacheKey}, one call per group at a time. */
async function fetchRepoPrGroups(requests: ReadonlyArray<Readonly<RepoPrsRequest>>) {
    const groupAnswers = await awaitedBlockingMap(
        packGraphqlParts({
            parts: requests,
            /** The open and terminal lists, plus the two lists inside each open PR. */
            countRequests(request) {
                return 2 + 2 * request.openPrLimit;
            },
        }),
        fetchRepoPrGroup,
    );
    return new Map(groupAnswers.flat());
}

async function fetchRepoPrGroup(group: ReadonlyArray<Readonly<RepoPrsRequest>>) {
    const result = await runGh([
        'api',
        'graphql',
        '--include',
        '-f',
        `query=${buildRepoPrsQuery(group.map((request) => request.openPrLimit))}`,
        ...group.flatMap((request, index) => {
            return [
                '-f',
                `owner${index}=${request.slug.owner}`,
                '-f',
                `name${index}=${request.slug.name}`,
            ];
        }),
    ]);
    const response = splitIncludedHeaders(result.stdout);
    if (result.exitCode !== 0 && looksRateLimited(result.stderr)) {
        throw new GitHubPollingError(
            GitHubPollingDisableReason.RateLimited,
            `GitHub API rate limit hit: ${result.stderr.trim()}`,
            readRateLimitResumeAtMs(response.headers),
        );
    } else if (result.exitCode !== 0 && looksUnauthenticated(result.stderr)) {
        throw new GitHubPollingError(
            GitHubPollingDisableReason.Unauthenticated,
            `GitHub authentication failed: ${result.stderr.trim()}`,
        );
    }
    try {
        /**
         * `gh` exits non-zero when GitHub fails any one repo, such as one deleted since, but still
         * prints GitHub's answers for the rest.
         */
        const answers = parseRepoPrsAnswer(response.body);
        return group.flatMap((request, index) => {
            const answer = answers[`repo${index}`];
            return answer
                ? [
                      [
                          repoCacheKey(request.slug),
                          answer,
                      ] satisfies [
                          string,
                          RepoPrsAnswer,
                      ],
                  ]
                : [];
        });
    } catch (error) {
        if (result.exitCode === 0) {
            log.warning(
                `Unreadable PR list for ${group.map((request) => repoCacheKey(request.slug)).join(', ')}: ${extractErrorMessage(error)}`,
            );
        }
        return [];
    }
}

type RepoPrsAnswer = NonNullable<ReturnType<typeof parseRepoPrsAnswer>[string]>;

/**
 * Each `repo<index>` alias's answer to {@link buildRepoPrsQuery}, undefined for a repository GitHub
 * didn't answer. Throws when the answer doesn't match the query.
 *
 * Exported for tests — everything above it in {@link fetchRepoPrs} needs a live `gh`.
 */
export function parseRepoPrsAnswer(graphqlOutput: string) {
    return mapObjectValuesSync(
        parseJsonWithShape(graphqlOutput, repoPrsResponseShape).data || {},
        (_alias, repository) => {
            return repository
                ? {
                      prsByBranch: buildPrsByBranch({
                          openNodes: repository.open.nodes,
                          terminalNodes: repository.terminal.nodes,
                      }),
                      openPrCount: repository.open.nodes.length,
                      hasMoreOpenPrs: repository.open.pageInfo.hasNextPage,
                      changeKeysByBranch: new Map(
                          repository.open.nodes.map((node) => {
                              return [
                                  node.headRefName,
                                  createHash('sha256').update(JSON.stringify(node)).digest('hex'),
                              ] satisfies [
                                  string,
                                  string,
                              ];
                          }),
                      ),
                  }
                : undefined;
        },
    );
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
