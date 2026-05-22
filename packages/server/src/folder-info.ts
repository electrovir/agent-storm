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
import {loadConfig} from './config.js';
import {folderInfoCachePath, notCommittedDir} from './file-paths.js';
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
 * repo per ~5 min, regardless of how many worktrees the user has against that repo. At 50 nodes per
 * call this comes out to ~600 GraphQL points/hour per active repo — well under the 5000 points/hour
 * primary rate limit, even with several repos configured.
 */
const repoPrCacheTtlMs = 5 * 60 * 1_000;

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
 * In-memory auto-disable state for GitHub polling. Set the first time the GraphQL call surfaces a
 * rate-limit or auth failure; subsequent sweeps skip the GitHub call entirely. Cleared on server
 * restart — that's the recovery path for rate limits, and the moment the user is most likely to
 * have fixed an auth issue. The user's explicit `disabledGitHubPolling: true` config takes
 * precedence either way; this only flips an implicit off-switch.
 */
const githubPollingState: {
    autoDisabled: boolean;
    reason: GitHubPollingDisableReason | undefined;
} = {
    autoDisabled: false,
    reason: undefined,
};

function isGitHubPollingDisabled(config: Readonly<Config>): boolean {
    return !!config.disabledGitHubPolling || githubPollingState.autoDisabled;
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

async function getCachedRepoPrMap(slug: Readonly<RepoSlug>): Promise<Map<string, PrInfo>> {
    const key = repoCacheKey(slug);
    const existing = repoPrCache.get(key);
    if (existing && Date.now() - existing.fetchedAt < repoPrCacheTtlMs) {
        return existing.prsByBranch;
    }
    try {
        const prsByBranch = await fetchRepoPrs(slug);
        repoPrCache.set(key, {
            fetchedAt: Date.now(),
            prsByBranch,
        });
        return prsByBranch;
    } catch (error) {
        if (error instanceof GitHubPollingError) {
            githubPollingState.autoDisabled = true;
            githubPollingState.reason = error.reason;
            log.warning(
                `GitHub polling auto-disabled (${error.reason}); restart the server to retry. ${error.message}`,
            );
            return new Map();
        }
        throw error;
    }
}

async function getCachedPrInfo(folder: string, branch: string | null): Promise<PrInfo | null> {
    if (!branch) {
        return null;
    }
    const slug = await ensureRepoSlug(folder);
    if (!slug) {
        return null;
    }
    const prsByBranch = await getCachedRepoPrMap(slug);
    return prsByBranch.get(branch) || null;
}

type RefreshTarget = {
    folder: string;
    parentRepoPath: string | null;
    isWorktreeRoot: boolean;
    aiHidden: boolean;
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
                },
                ...children.map(
                    (child): RefreshTarget => ({
                        folder: child,
                        parentRepoPath: repo.path,
                        isWorktreeRoot: false,
                        aiHidden: config.hiddenAiPane.includes(child),
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
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    disabledGitHubPolling: boolean;
}>): Promise<FolderInfo> {
    const git = await getGitInfo(target.folder);
    const pr =
        target.isWorktreeRoot || disabledGitHubPolling
            ? null
            : await getCachedPrInfo(target.folder, git.branch);
    return {
        path: target.folder,
        name: basename(target.folder),
        parentRepoPath: target.parentRepoPath,
        isWorktreeRoot: target.isWorktreeRoot,
        aiHidden: target.aiHidden,
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
            refreshState.targets = parsed.targets;
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

/**
 * Pause between consecutive folder refreshes within a sweep. Each folder costs roughly 4 git
 * subprocesses (`rev-parse`, `status --porcelain`, upstream check, `log` ahead-count); spreading
 * them out keeps the backend from pegging a core when the user has many configured repos.
 */
const perFolderDelayMs = 500;
/**
 * Idle pause after each complete sweep through every folder. With ~30 folders × 500ms each, a sweep
 * takes ~15s; a 10s idle on top gives roughly one full refresh every 25s. Plenty fresh for a
 * slow-moving UI; cheap on the host.
 */
const sweepIdleMs = 10_000;

async function refreshOnce(
    target: RefreshTarget,
    statusLookup: PaneStatusLookup,
    disabledGitHubPolling: boolean,
): Promise<void> {
    try {
        const info = await buildFolderInfo({
            target,
            statusLookup,
            disabledGitHubPolling,
        });
        cache.set(target.folder, info);
        persistCache();
    } catch {
        /* swallow per-folder errors so one bad repo doesn't stop the sweep */
    }
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
     * Sequential on purpose: parallel refresh is what created the original 100% CPU problem.
     * `awaitedForEach` awaits each callback before invoking the next, so subprocess pressure stays
     * at one folder at a time.
     */
    await awaitedForEach(targets, async (target) => {
        await refreshOnce(target, statusLookup, disabledGitHubPolling);
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
    runSweep()
        .catch(() => {
            /* never let the loop die; just move on to the next sweep */
        })
        .finally(scheduleNextSweep);
}
