import {
    folderInfoShape,
    PaneKind,
    PaneStatus,
    type Config,
    type FolderInfo,
} from '@agent-storm/common';
import {awaitedForEach, log, wait} from '@augment-vir/common';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {checkValidShape} from 'object-shape-tester';
import {getFolderAiCmd, loadConfig, saveConfig} from './config.js';
import {folderInfoCachePath, githubCachePath, notCommittedDir} from './file-paths.js';
import {
    fetchRepoPrs,
    getGitInfo,
    getRepoSlug,
    GitHubPollingError,
    isWorktreeRoot,
    listWorktreeChildren,
    type GitHubPollingDisableReason,
    type PrInfo,
    type RepoSlug,
} from './git.js';
import {getPaneStatusLookup} from './pty.js';

type PaneStatusLookup = (folder: string, kind: PaneKind) => PaneStatus;

/**
 * How long a freshly-fetched per-repo PR map is reused before the next folder sweep re-fetches it.
 * Per-repo (not per-branch) caching is what keeps GitHub traffic small: one GraphQL call per unique
 * repo per ~1 min, regardless of how many worktrees the user has against that repo. At 20 nodes per
 * call this comes out to ~1200 GraphQL points/hour per active repo — still well under the 5000
 * points/hour primary rate limit, but watch the per-call `cost=` log line if multiple repos are
 * active simultaneously since traffic scales linearly with active-repo count.
 */
const repoPrCacheTtlMs = 60 * 1000;

type RepoPrCacheEntry = {
    fetchedAt: number;
    prsByBranch: Map<string, PrInfo>;
};

/** Key: `${owner}/${name}`. See {@link repoCacheKey}. */
const repoPrCache = new Map<string, RepoPrCacheEntry>();

/**
 * Per-folder resolved GitHub slug. The slug comes from `git remote get-url origin` and never
 * changes during a single server run, so we resolve it once and reuse forever. `null` entries cache
 * "folder isn't a GitHub repo" answers so we don't shell out to git on every sweep just to
 * re-confirm.
 */
const repoSlugByFolder = new Map<string, RepoSlug | null>();

function repoCacheKey(slug: Readonly<RepoSlug>): string {
    return `${slug.owner}/${slug.name}`;
}

/**
 * GitHub primary rate limit resets hourly. When we observe a rate-limit error we can't read the
 * exact reset timestamp from `gh`'s stderr, so back off for a full hour — long enough to cover the
 * worst case where we hit the limit right after the previous reset.
 */
const autoDisableRateLimitMs = 60 * 60 * 1000;
/**
 * Auth failures don't auto-recover; the user has to re-run `gh auth login`. Back off long enough
 * that the warning isn't spamming logs, but short enough that the next sweep after they fix it
 * picks it back up.
 */
const autoDisableAuthMs = 10 * 60 * 1000;

/**
 * Auto-disable state for GitHub polling. Set when a GraphQL call surfaces rate-limit or auth
 * failure; subsequent sweeps skip the GitHub call until `disabledUntilMs` elapses. Persisted to
 * disk so `tsx --watch` restarts during dev don't immediately re-poll GitHub and hit the same rate
 * limit again. The user's explicit `disabledGitHubPolling: true` config takes precedence either
 * way; this only flips an implicit off-switch.
 */
const githubPollingState: {
    autoDisabled: boolean;
    reason: GitHubPollingDisableReason | undefined;
    disabledUntilMs: number;
} = {
    autoDisabled: false,
    reason: undefined,
    disabledUntilMs: 0,
};

function isAutoDisabled(): boolean {
    if (!githubPollingState.autoDisabled) {
        return false;
    } else if (Date.now() >= githubPollingState.disabledUntilMs) {
        githubPollingState.autoDisabled = false;
        githubPollingState.reason = undefined;
        githubPollingState.disabledUntilMs = 0;
        void persistAutoDisableToConfig();
        return false;
    }
    return true;
}

/**
 * Chain of in-flight config writes for the auto-disable field. The config file is a user-edited
 * JSON; we don't want overlapping writes from successive rate-limit events to interleave or to race
 * with a config save from the settings modal — chaining serializes them.
 */
const autoDisableWriteState: {pending: Promise<void>} = {
    pending: Promise.resolve(),
};

async function persistAutoDisableToConfig(): Promise<void> {
    autoDisableWriteState.pending = autoDisableWriteState.pending
        .catch(() => {
            /* prior write failed; carry on so the next one still has a chance */
        })
        .then(async () => {
            /**
             * Skip the write if `loadConfig` can't read the current file. Previously a transient
             * read failure here would return `defaultConfig` and the subsequent `saveConfig` would
             * clobber every user setting (repos list, AI cmd overrides, etc.) just to record an
             * auto-disable flag. Now we bail; the auto-disable still lives in memory for the rest
             * of the process and the next attempt after the file is readable will persist it.
             */
            const config = await loadConfig().catch(() => undefined);
            if (!config) {
                return;
            }
            await saveConfig({
                ...config,
                githubPollingAutoDisable:
                    githubPollingState.autoDisabled && githubPollingState.reason
                        ? {
                              reason: githubPollingState.reason,
                              disabledUntilMs: githubPollingState.disabledUntilMs,
                          }
                        : null,
            });
        })
        .catch(() => {
            /* persistence is best-effort — losing a write just means a cold restart */
        });
    return autoDisableWriteState.pending;
}

function isValidAutoDisableReason(value: unknown): value is GitHubPollingDisableReason {
    return value === 'rate-limited' || value === 'unauthenticated';
}

function loadAutoDisableFromConfig(config: Readonly<Config>): void {
    const saved = config.githubPollingAutoDisable;
    if (
        !saved ||
        typeof saved.disabledUntilMs !== 'number' ||
        Date.now() >= saved.disabledUntilMs ||
        !isValidAutoDisableReason(saved.reason)
    ) {
        return;
    }
    githubPollingState.autoDisabled = true;
    githubPollingState.reason = saved.reason;
    githubPollingState.disabledUntilMs = saved.disabledUntilMs;
    const minutesLeft = Math.max(1, Math.round((saved.disabledUntilMs - Date.now()) / 60_000));
    log.warning(
        `GitHub polling still auto-disabled from prior run (${saved.reason}); ${minutesLeft} min remaining.`,
    );
}

function markAutoDisabled(reason: GitHubPollingDisableReason, message: string): void {
    const wasDisabled = githubPollingState.autoDisabled;
    const backoffMs = reason === 'rate-limited' ? autoDisableRateLimitMs : autoDisableAuthMs;
    githubPollingState.autoDisabled = true;
    githubPollingState.reason = reason;
    githubPollingState.disabledUntilMs = Date.now() + backoffMs;
    if (!wasDisabled) {
        const minutes = Math.round(backoffMs / 60_000);
        log.warning(
            `GitHub polling auto-disabled (${reason}); backing off ${minutes} min. ${message}`,
        );
    }
    void persistAutoDisableToConfig();
}

/**
 * Mirror of `config.disabledGitHubPolling`, refreshed on each sweep + on startup. Lets the
 * lowest-level fetch site short-circuit without re-reading the config file on every call. The
 * config is still the source of truth — this is just a hot cache so `getCachedRepoPrMap` can gate
 * without I/O.
 */
const userPollingState: {manuallyDisabled: boolean} = {
    manuallyDisabled: false,
};

function isUserPollingDisabled(): boolean {
    return userPollingState.manuallyDisabled;
}

function isGitHubPollingDisabled(config: Readonly<Config>): boolean {
    return config.disabledGitHubPolling || isAutoDisabled();
}

async function ensureRepoSlug(folder: string): Promise<RepoSlug | null> {
    const cached = repoSlugByFolder.get(folder);
    if (cached !== undefined) {
        return cached;
    }
    const slug = await getRepoSlug(folder);
    repoSlugByFolder.set(folder, slug);
    return slug;
}

async function getCachedRepoPrMap(
    slug: Readonly<RepoSlug>,
    allowFetch: boolean,
): Promise<Map<string, PrInfo>> {
    /**
     * Belt-and-braces gate against the user's manual kill-switch. The high-level caller in
     * `buildFolderInfo` already short-circuits on `disabledGitHubPolling`, but checking here too
     * means any future call path can't accidentally bypass the user's preference — even cache
     * misses get short-circuited before any network call could be attempted.
     */
    if (isUserPollingDisabled()) {
        return new Map();
    }
    const key = repoCacheKey(slug);
    const existing = repoPrCache.get(key);
    if (existing && Date.now() - existing.fetchedAt < repoPrCacheTtlMs) {
        return existing.prsByBranch;
        /**
         * The caller-decided gate: skip the network trip entirely when the repo has no active
         * panes. Cache hits above still serve stale data (within the TTL) so the sidebar's PR
         * badges stay accurate for inactive folders; we just don't spend GraphQL points refreshing
         * them.
         */
    } else if (!allowFetch) {
        return new Map();
        /**
         * Belt-and-braces gate: `buildFolderInfo` already short-circuits on the per-sweep
         * `disabledGitHubPolling` flag, but that flag is captured once at sweep start so a folder
         * that triggers auto-disable mid-sweep would still let later folders in the same sweep hit
         * the API. Re-check on every call so the very next folder skips its own GraphQL trip.
         */
    } else if (isAutoDisabled()) {
        return new Map();
    }
    try {
        const prsByBranch = await fetchRepoPrs(slug);
        repoPrCache.set(key, {
            fetchedAt: Date.now(),
            prsByBranch,
        });
        persistGithubCache();
        return prsByBranch;
    } catch (error) {
        if (error instanceof GitHubPollingError) {
            markAutoDisabled(error.reason, error.message);
            return new Map();
        }
        throw error;
    }
}

async function getCachedPrInfo(
    folder: string,
    branch: string | null,
    allowFetch: boolean,
): Promise<PrInfo | null> {
    if (!branch) {
        return null;
    }
    const slug = await ensureRepoSlug(folder);
    if (!slug) {
        return null;
    }
    const prsByBranch = await getCachedRepoPrMap(slug, allowFetch);
    return prsByBranch.get(branch) || null;
}

type RefreshTarget = {
    folder: string;
    parentRepoPath: string | null;
    isWorktreeRoot: boolean;
    aiHidden: boolean;
    aiCmd: string;
};

async function enumerateTargets(config: Readonly<Config>): Promise<RefreshTarget[]> {
    const perRepo = await Promise.all(
        config.repos.map(async (repo): Promise<RefreshTarget[]> => {
            const isRoot = await isWorktreeRoot(repo.path);
            if (!isRoot) {
                return [
                    {
                        folder: repo.path,
                        parentRepoPath: null,
                        isWorktreeRoot: false,
                        aiHidden: config.hiddenAiPane.includes(repo.path),
                        aiCmd: getFolderAiCmd({
                            config,
                            folder: repo.path,
                        }),
                    },
                ];
            }
            const children = await listWorktreeChildren(repo.path);
            return [
                {
                    folder: repo.path,
                    parentRepoPath: null,
                    isWorktreeRoot: true,
                    aiHidden: false,
                    aiCmd: getFolderAiCmd({
                        config,
                        folder: repo.path,
                    }),
                },
                ...children.map(
                    (child): RefreshTarget => ({
                        folder: child,
                        parentRepoPath: repo.path,
                        isWorktreeRoot: false,
                        aiHidden: config.hiddenAiPane.includes(child),
                        aiCmd: getFolderAiCmd({
                            config,
                            folder: child,
                            fallbackFolders: [repo.path],
                        }),
                    }),
                ),
            ];
        }),
    );
    return perRepo.flat();
}

async function buildFolderInfo({
    target,
    statusLookup,
    disabledGitHubPolling,
    repoHasActivePane,
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    disabledGitHubPolling: boolean;
    repoHasActivePane: boolean;
}>): Promise<FolderInfo> {
    const git = await getGitInfo(target.folder);
    const pr =
        target.isWorktreeRoot || disabledGitHubPolling
            ? null
            : await getCachedPrInfo(target.folder, git.branch, repoHasActivePane);
    return {
        path: target.folder,
        name: basename(target.folder),
        parentRepoPath: target.parentRepoPath,
        isWorktreeRoot: target.isWorktreeRoot,
        aiHidden: target.aiHidden,
        aiCmd: target.aiCmd,
        branch: git.branch,
        git: {
            dirty: git.dirty,
            notPushed: git.notPushed,
        },
        prUrl: pr?.url || null,
        prMerged: !!pr?.closed,
        panes: {
            ai: statusLookup(target.folder, PaneKind.Ai),
            shell: statusLookup(target.folder, PaneKind.Shell),
        },
    };
}

/**
 * Last-known FolderInfo per folder path. The `/folders` endpoint returns a snapshot of this map;
 * the background loop below is the only thing that writes to it. Frontend polling NEVER triggers a
 * refresh — it just reads whatever is here. Order is preserved in insertion-time order, which is
 * the iteration order of the current config's repos + their worktree children, so consumers can
 * render without re-sorting.
 */
const cache = new Map<string, FolderInfo>();
/**
 * Mutable module-level state for the refresh loop. Kept on a single object so we can avoid `let`
 * for each field. `targets` is the most recent enumeration result; the endpoint walks it to emit
 * folders in config order, falling back to a git-less placeholder for any target the background
 * sweep hasn't refreshed yet. `loopStarted` guards `startFolderInfoRefreshLoop` against being
 * called twice.
 */
const refreshState: {
    targets: ReadonlyArray<RefreshTarget>;
    loopStarted: boolean;
} = {
    targets: [],
    loopStarted: false,
};

/**
 * Synthesize a FolderInfo with the bits we can know without running git or talking to the daemon.
 * Used by `getCachedFolders` so the sidebar can render every configured folder immediately on first
 * load; git/PR/pane fields pop in as the background sweep fills the cache.
 */
function placeholderFolderInfo(target: RefreshTarget): FolderInfo {
    return {
        path: target.folder,
        name: basename(target.folder),
        parentRepoPath: target.parentRepoPath,
        isWorktreeRoot: target.isWorktreeRoot,
        aiHidden: target.aiHidden,
        aiCmd: target.aiCmd,
        branch: null,
        git: {
            dirty: false,
            notPushed: false,
        },
        prUrl: null,
        prMerged: false,
        panes: {
            ai: PaneStatus.None,
            shell: PaneStatus.None,
        },
    };
}

/**
 * Pane status changes (Busy ↔ Idle) need to surface within a frontend poll, not within the slow
 * git-driven sweep cycle. Overlay live statuses from the daemon (cached at 500ms in
 * `getPaneStatusLookup`) on top of the cached FolderInfo so the sidebar's loader icon flips ~within
 * one poll interval of the pane going busy, instead of waiting for the next 25s sweep to bake the
 * new status into the cache.
 */
export async function getCachedFolders(): Promise<FolderInfo[]> {
    const statusLookup = await getPaneStatusLookup();
    return refreshState.targets.map((target) => {
        const base = cache.get(target.folder) || placeholderFolderInfo(target);
        return {
            ...base,
            panes: {
                ai: statusLookup(target.folder, PaneKind.Ai),
                shell: statusLookup(target.folder, PaneKind.Shell),
            },
        };
    });
}

type PersistedCache = {
    targets: RefreshTarget[];
    entries: ReadonlyArray<
        readonly [
            string,
            FolderInfo,
        ]
    >;
};

/**
 * Chain of in-flight cache writes. New writes append rather than racing so we never have two
 * `writeFile` calls overlapping on the same path; each `persistCache` snapshot is captured
 * synchronously at call time so the chained write reflects the state at the moment of the call.
 */
const persistState: {pending: Promise<void>} = {
    pending: Promise.resolve(),
};

function persistCache(): void {
    const snapshot: PersistedCache = {
        targets: [...refreshState.targets],
        entries: Array.from(cache.entries()),
    };
    persistState.pending = persistState.pending
        .catch(() => {
            /* prior write failed; carry on so the next one still has a chance */
        })
        .then(async () => {
            await mkdir(notCommittedDir, {
                recursive: true,
            });
            await writeFile(folderInfoCachePath, JSON.stringify(snapshot), 'utf-8');
        })
        .catch(() => {
            /* persistence is best-effort — losing a write just means a cold restart */
        });
}

async function loadPersistedCache(): Promise<void> {
    const contents = await readFile(folderInfoCachePath, 'utf-8').catch(() => undefined);
    if (!contents) {
        return;
    }
    try {
        const parsed = JSON.parse(contents) as PersistedCache;
        if (Array.isArray(parsed.targets) && Array.isArray(parsed.entries)) {
            refreshState.targets = parsed.targets.map((target) => ({
                ...target,
                aiCmd: typeof target.aiCmd === 'string' ? target.aiCmd : '',
            }));
            /**
             * Validate each entry against the current shape so a schema change (renamed/added
             * field) doesn't poison the `/folders` response with stale objects. Invalid entries are
             * dropped; the next sweep refills them.
             */
            parsed.entries.forEach(
                ([
                    path,
                    info,
                ]) => {
                    if (checkValidShape(info, folderInfoShape)) {
                        cache.set(path, info);
                    }
                },
            );
        }
    } catch {
        /* corrupted persisted file — ignore and let the live sweep rebuild it */
    }
}

type PersistedGithubCache = {
    repos: ReadonlyArray<
        readonly [
            string,
            {
                fetchedAt: number;
                prs: ReadonlyArray<
                    readonly [
                        string,
                        PrInfo,
                    ]
                >;
            },
        ]
    >;
};

const githubPersistState: {pending: Promise<void>} = {
    pending: Promise.resolve(),
};

function persistGithubCache(): void {
    const snapshot: PersistedGithubCache = {
        repos: Array.from(
            repoPrCache.entries(),
            ([
                key,
                entry,
            ]) => [
                key,
                {
                    fetchedAt: entry.fetchedAt,
                    prs: Array.from(entry.prsByBranch.entries()),
                },
            ],
        ),
    };
    githubPersistState.pending = githubPersistState.pending
        .catch(() => {
            /* prior write failed; carry on so the next one still has a chance */
        })
        .then(async () => {
            await mkdir(notCommittedDir, {
                recursive: true,
            });
            await writeFile(githubCachePath, JSON.stringify(snapshot), 'utf-8');
        })
        .catch(() => {
            /* persistence is best-effort — losing a write just means a cold restart */
        });
}

async function loadPersistedGithubCache(): Promise<void> {
    const contents = await readFile(githubCachePath, 'utf-8').catch(() => undefined);
    if (!contents) {
        return;
    }
    try {
        const parsed = JSON.parse(contents) as PersistedGithubCache;
        if (Array.isArray(parsed.repos)) {
            parsed.repos.forEach(
                ([
                    key,
                    entry,
                ]) => {
                    if (
                        typeof entry?.fetchedAt !== 'number' ||
                        !Array.isArray(entry.prs) ||
                        /** Drop already-expired entries so we don't pretend stale data is fresh. */
                        Date.now() - entry.fetchedAt >= repoPrCacheTtlMs
                    ) {
                        return;
                    }
                    repoPrCache.set(key, {
                        fetchedAt: entry.fetchedAt,
                        prsByBranch: new Map(entry.prs),
                    });
                },
            );
        }
    } catch {
        /* corrupted persisted file — ignore and let the live sweep rebuild it */
    }
}

/**
 * Pause between consecutive folder refreshes within a sweep. Each folder costs roughly 4 git
 * subprocesses (`rev-parse`, `status --porcelain`, upstream check, `log` ahead-count); spreading
 * them out keeps the backend from pegging a core when the user has many configured repos. 100ms
 * gives a ~3s sweep over ~30 folders while keeping CPU usage modest.
 */
const perFolderDelayMs = 100;
/**
 * Idle pause after each complete sweep through every folder. Tuned so the full cycle (sweep + idle)
 * lands near ~10s for typical folder counts, so the sidebar's `*` / `+` markers reflect dirty / not
 * pushed state within a poll interval of git activity. PR fetches piggy-back on this sweep but are
 * gated by the 10-min `repoPrCacheTtlMs`, so a faster sweep does not mean more GitHub traffic.
 */
const sweepIdleMs = 5000;

async function refreshOnce(
    target: RefreshTarget,
    statusLookup: PaneStatusLookup,
    disabledGitHubPolling: boolean,
    repoHasActivePane: boolean,
): Promise<void> {
    try {
        const info = await buildFolderInfo({
            target,
            statusLookup,
            disabledGitHubPolling,
            repoHasActivePane,
        });
        cache.set(target.folder, info);
        persistCache();
    } catch {
        /* swallow per-folder errors so one bad repo doesn't stop the sweep */
    }
}

function isLivePaneStatus(status: PaneStatus): boolean {
    return status === PaneStatus.Busy || status === PaneStatus.Idle;
}

/**
 * Group key used to decide whether a repo "has an active pane". All worktrees of a given repo, plus
 * the worktree-root entry itself, share the same key — `parentRepoPath` when the target is a
 * worktree child, or the target's own path when it's the repo entry. Activity on any one folder
 * unlocks the GraphQL fetch for the whole group.
 */
function repoActivityKey(target: RefreshTarget): string {
    return target.parentRepoPath || target.folder;
}

function computeActiveRepoKeys(
    targets: ReadonlyArray<RefreshTarget>,
    statusLookup: PaneStatusLookup,
): Set<string> {
    const active = new Set<string>();
    targets.forEach((target) => {
        if (
            isLivePaneStatus(statusLookup(target.folder, PaneKind.Ai)) ||
            isLivePaneStatus(statusLookup(target.folder, PaneKind.Shell))
        ) {
            active.add(repoActivityKey(target));
        }
    });
    return active;
}

async function runSweep(): Promise<void> {
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return;
    }
    const targets = await enumerateTargets(config);
    /**
     * Publish the target list before the slow per-folder loop runs so `/folders` can return
     * placeholders for every configured folder immediately, without waiting for git to finish.
     */
    refreshState.targets = targets;
    persistCache();
    const statusLookup = await getPaneStatusLookup();
    const disabledGitHubPolling = isGitHubPollingDisabled(config);
    /**
     * Snapshot which repos have at least one live pane (AI or Shell, Busy or Idle) at sweep start.
     * `getCachedRepoPrMap` uses this to skip the GraphQL fetch for repos the user isn't actively
     * working with — cache hits still serve their stale data, but no network trip is spent
     * refreshing PRs for an inactive repo.
     */
    const activeRepoKeys = computeActiveRepoKeys(targets, statusLookup);
    /**
     * Sequential on purpose: parallel refresh is what created the original 100% CPU problem.
     * `awaitedForEach` awaits each callback before invoking the next, so subprocess pressure stays
     * at one folder at a time.
     */
    await awaitedForEach(targets, async (target) => {
        await refreshOnce(
            target,
            statusLookup,
            disabledGitHubPolling,
            activeRepoKeys.has(repoActivityKey(target)),
        );
        await wait({
            milliseconds: perFolderDelayMs,
        });
    });
    const validPaths = new Set(targets.map((target) => target.folder));
    const stale = Array.from(cache.keys()).filter((path) => !validPaths.has(path));
    stale.forEach((path) => cache.delete(path));
    if (stale.length > 0) {
        persistCache();
    }
}

/**
 * Re-enumerate targets right now and kick off a fresh sweep, in addition to (not replacing) the
 * scheduled background loop. The returned promise resolves once `refreshState.targets` reflects the
 * new layout, so by the time this returns the next `/folders` call will see new folders as
 * placeholders. Git/PR fields fill in via the background sweep started here, which may overlap with
 * an already-scheduled sweep — that's fine: cache writes are last-write-wins, `persistCache` chains
 * its writes, and the duplicate per-folder git work is cheap. Endpoints that mutate the worktree
 * layout (create/delete) call this so the UI updates within one poll instead of waiting up to a
 * full sweep cycle.
 */
export async function refreshFolderInfoNow(): Promise<void> {
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return;
    }
    refreshState.targets = await enumerateTargets(config);
    persistCache();
    void runSweep().catch(() => {
        /* never let an out-of-band sweep crash the process */
    });
}

/**
 * Schedules the next sweep `sweepIdleMs` after the current one finishes. Recursive `setTimeout`
 * rather than `setInterval` so sweeps never overlap if one runs long.
 */
function scheduleNextSweep(): void {
    setTimeout(() => {
        runSweep()
            .catch(() => {
                /* never let the loop die; just move on to the next sweep */
            })
            .finally(scheduleNextSweep);
    }, sweepIdleMs);
}

/**
 * Load any previously-persisted cache from disk, then kick off the never-ending background refresh
 * loop. Safe to call multiple times; only the first call has any effect. Each sweep walks every
 * configured folder in serial, refreshing one at a time, then idles before starting the next sweep.
 * Callers should `await` this before serving requests so the first `/folders` call sees
 * last-session data rather than an empty list.
 */
export async function startFolderInfoRefreshLoop(): Promise<void> {
    if (refreshState.loopStarted) {
        return;
    }
    refreshState.loopStarted = true;
    await loadPersistedCache();
    await loadPersistedGithubCache();
    const initialConfig = await loadConfig().catch(() => undefined);
    if (initialConfig) {
        loadAutoDisableFromConfig(initialConfig);
    }
    runSweep()
        .catch(() => {
            /* never let the loop die; just move on to the next sweep */
        })
        .finally(scheduleNextSweep);
}
