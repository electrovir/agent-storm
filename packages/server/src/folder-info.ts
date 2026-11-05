import {
    folderInfoShape,
    GitHubPollingDisableReason,
    PaneKind,
    PaneStatus,
    PrStatus,
    WatchModeStatus,
    type Config,
    type FolderInfo,
    type RepoConfig,
} from '@agent-storm/common';
import {
    awaitedForEach,
    extractErrorMessage,
    getEnumValues,
    log,
    mapEnumToObject,
    PromiseQueue,
    wait,
} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {readFile, stat} from 'node:fs/promises';
import {basename} from 'node:path';
import {
    checkValidShape,
    defineShape,
    nullableShape,
    optionalShape,
    parseJsonWithShape,
    tupleShape,
    unknownShape,
} from 'object-shape-tester';
import {repoCacheKey, repoPrCache} from './branch-prs.js';
import {getFolderAiDefinition, loadConfig, updateConfig} from './config.js';
import {folderInfoCachePath, githubCachePath} from './file-paths.js';
import {getFolderActivityAtMs} from './folder-activity.js';
import {
    fetchRepoPrs,
    getGitInfo,
    getRepoSlug,
    GitHubPollingError,
    isWorktreeRoot,
    listWorktreeChildren,
    prInfoShape,
    type PrInfo,
    type RepoSlug,
} from './git.js';
import {applyManualReviewStatus} from './github-review-queue.js';
import {getPaneSessionStatusLookup, getPaneStatusLookup} from './pty.js';
import {writeFileAtomically} from './write-file-atomically.js';

type PaneStatusLookup = (folder: string, kind: PaneKind) => PaneStatus;

const offWatchMode: FolderInfo['watchMode'] = {
    status: WatchModeStatus.Off,
    message: '',
};

/**
 * How long a per-repo PR map is reused before a sweep re-fetches it. Per-repo (not per-branch)
 * caching is what keeps GitHub traffic small: one GraphQL call per unique repo, regardless of how
 * many worktrees the user has against it, and each call costs a GraphQL point against GitHub's
 * hourly limit.
 *
 * Two tiers, because a repo you're working in should notice a new PR quickly and a repo you last
 * touched in March does not:
 *
 * - Hot: the repo has a live pane, or you activated it within {@link recentInteraction}.
 * - Cold: everything else that's still visible in the sidebar.
 *
 * Note that these govern only when a _refresh_ happens. A cached map is served no matter how old it
 * is (see {@link getCachedRepoPrMap}), which is what keeps PR markers on screen for repos that
 * aren't being refreshed at all.
 */
export const hotRepoPrTtl: AnyDuration = {
    minutes: 5,
};
export const coldRepoPrTtl: AnyDuration = {
    minutes: 30,
};

/** How long after the user last activated a repo it still counts as hot. */
const recentInteraction: AnyDuration = {
    minutes: 10,
};

/**
 * Recency window for the sidebar's "Hide Inactive" filter, mirroring `recencyWindow` in
 * `vir-sidebar.element.ts`. A standalone repo outside this window with no live pane isn't rendered
 * while the filter is on, so there's no marker for a PR fetch to feed.
 */
const sidebarRecencyWindow: AnyDuration = {
    days: 7,
};

/** Whether a pane in this state counts as the user working in its repo. */
const livePaneStatuses: Readonly<Record<PaneStatus, boolean>> = {
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: true,
    [PaneStatus.Exited]: false,
    [PaneStatus.None]: false,
};

/**
 * Repo paths (the {@link repoActivityKey} group key) that have produced at least one PR at some
 * point. Sticky and persisted: once a repo is known to be a repo the user opens PRs against, it
 * stays eligible for polling even after its last PR ages out of the terminal-PR window.
 *
 * This is what lets the sweep skip plain repos entirely — no worktrees, no PR ever seen means the
 * user doesn't do PR work there and a GraphQL call for it is pure waste. Such a repo re-qualifies
 * the moment it becomes active (a live pane or a fresh activation), which is exactly when its first
 * PR would appear, so the exclusion can't strand a repo forever.
 */
const everHadPrRepoPaths = new Set<string>();

function markRepoHadPr(repoPath: string): void {
    if (!everHadPrRepoPaths.has(repoPath)) {
        everHadPrRepoPaths.add(repoPath);
        persistGithubCache();
    }
}

/**
 * Per-folder resolved GitHub slug. The slug comes from `git remote get-url origin` and never
 * changes during a single server run, so we resolve it once and reuse forever. `null` entries cache
 * "folder isn't a GitHub repo" answers so we don't shell out to git on every sweep just to
 * re-confirm.
 */
const repoSlugByFolder = new Map<string, RepoSlug | null>();

/** How long polling backs off for each failure when GitHub doesn't say when to resume. */
const autoDisableDurationByReason: Readonly<Record<GitHubPollingDisableReason, AnyDuration>> = {
    /**
     * The primary rate limit resets hourly, so a full hour covers the worst case where we hit the
     * limit right after the previous reset.
     */
    [GitHubPollingDisableReason.RateLimited]: {
        hours: 1,
    },
    /**
     * Auth failures don't auto-recover; the user has to re-run `gh auth login`. Back off long
     * enough that the warning isn't spamming logs, but short enough that the next sweep after they
     * fix it picks it back up.
     */
    [GitHubPollingDisableReason.Unauthenticated]: {
        minutes: 10,
    },
};

/**
 * Auto-disable state for GitHub polling. Set when a GraphQL call surfaces rate-limit or auth
 * failure; GitHub calls are skipped until `disabledUntilMs` elapses. Persisted to the config so
 * `tsx --watch` restarts during dev don't immediately re-poll GitHub and hit the same rate limit
 * again. The user's explicit `disabledGitHubPolling: true` config takes precedence either way; this
 * only flips an implicit off-switch.
 */
const githubPollingState: {
    autoDisable:
        | {
              reason: GitHubPollingDisableReason;
              disabledUntilMs: number;
          }
        | undefined;
} = {
    autoDisable: undefined,
};

function isAutoDisabled(): boolean {
    return (
        !!githubPollingState.autoDisable &&
        Date.now() < githubPollingState.autoDisable.disabledUntilMs
    );
}

/** Forgets an auto-disable whose backoff has run out, so the config stops carrying it. */
async function clearExpiredAutoDisable(): Promise<void> {
    if (githubPollingState.autoDisable && !isAutoDisabled()) {
        githubPollingState.autoDisable = undefined;
        await persistAutoDisableToConfig();
    }
}

async function persistAutoDisableToConfig(): Promise<void> {
    await updateConfig((config) => {
        return {
            ...config,
            githubPollingAutoDisable: githubPollingState.autoDisable || null,
        };
    }).catch((error: unknown) => {
        log.warning(`Failed to save GitHub polling auto-disable: ${extractErrorMessage(error)}`);
    });
}

function loadAutoDisableFromConfig(config: Readonly<Config>): void {
    const saved = config.githubPollingAutoDisable;
    if (!saved || Date.now() >= saved.disabledUntilMs) {
        return;
    }
    githubPollingState.autoDisable = {
        reason: saved.reason,
        disabledUntilMs: saved.disabledUntilMs,
    };
    const minutesLeft = Math.max(
        1,
        Math.round(
            convertDuration(
                {
                    milliseconds: saved.disabledUntilMs - Date.now(),
                },
                {
                    minutes: true,
                },
            ).minutes,
        ),
    );
    log.warning(
        `GitHub polling still auto-disabled from prior run (${saved.reason}); ${minutesLeft} min remaining.`,
    );
}

function markAutoDisabled({
    reason,
    message,
    resumeAtMs,
}: Readonly<{
    reason: GitHubPollingDisableReason;
    message: string;
    resumeAtMs: number | undefined;
}>): void {
    const wasDisabled = isAutoDisabled();
    const backoffMs =
        resumeAtMs == undefined
            ? convertDuration(autoDisableDurationByReason[reason], {
                  milliseconds: true,
              }).milliseconds
            : Math.max(0, resumeAtMs - Date.now());
    githubPollingState.autoDisable = {
        reason,
        disabledUntilMs: Date.now() + backoffMs,
    };
    if (!wasDisabled) {
        const minutes = Math.max(
            1,
            Math.round(
                convertDuration(
                    {
                        milliseconds: backoffMs,
                    },
                    {
                        minutes: true,
                    },
                ).minutes,
            ),
        );
        log.warning(
            `GitHub polling auto-disabled (${reason}); backing off ${minutes} min. ${message}`,
        );
    }
    void persistAutoDisableToConfig();
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

/**
 * The repo's branch → PR lookup, refreshing it first if the cached copy is older than `refreshTtl`.
 * An `undefined` TTL means "never refresh this repo" (it isn't visible in the sidebar).
 *
 * Whatever is cached is always returned, however stale, and that's deliberate: a marker built from
 * an hour-old fetch is right far more often than no marker at all, and the alternative — returning
 * an empty map whenever a refresh is skipped — is what made PRs vanish from the sidebar for every
 * repo the user wasn't actively running a pane in.
 */
async function getCachedRepoPrMap(
    slug: Readonly<RepoSlug>,
    refreshTtl: AnyDuration | undefined,
): Promise<Map<string, PrInfo>> {
    const key = repoCacheKey(slug);
    const cached = repoPrCache.get(key)?.prsByBranch || new Map<string, PrInfo>();
    const fetchedAt = repoPrCache.get(key)?.fetchedAt || 0;
    /**
     * Auto-disable is re-checked here rather than trusted from the caller: the per-sweep flag is
     * captured once at sweep start, so a folder that trips auto-disable mid-sweep would otherwise
     * let every later folder in that same sweep hit the API.
     */
    if (
        isAutoDisabled() ||
        refreshTtl == undefined ||
        Date.now() - fetchedAt <
            convertDuration(refreshTtl, {
                milliseconds: true,
            }).milliseconds
    ) {
        return cached;
    }
    try {
        const prsByBranch = (await fetchRepoPrs(slug)) || cached;
        repoPrCache.set(key, {
            fetchedAt: Date.now(),
            prsByBranch,
        });
        persistGithubCache();
        return prsByBranch;
    } catch (error) {
        if (error instanceof GitHubPollingError) {
            markAutoDisabled({
                reason: error.reason,
                message: error.message,
                resumeAtMs: error.resumeAtMs,
            });
            return cached;
        }
        throw error;
    }
}

async function getCachedPrInfo(
    folder: string,
    branch: string | null,
    refreshTtl: AnyDuration | undefined,
): Promise<PrInfo | null> {
    if (!branch) {
        return null;
    }
    const slug = await ensureRepoSlug(folder);
    if (!slug) {
        return null;
    }
    const pr = (await getCachedRepoPrMap(slug, refreshTtl)).get(branch);
    return pr
        ? {
              ...pr,
              status: await applyManualReviewStatus({
                  prStatus: pr.status,
                  owner: slug.owner,
                  repoName: slug.name,
                  branchName: branch,
              }),
          }
        : null;
}

const refreshTargetShape = defineShape({
    folder: '',
    parentRepoPath: nullableShape(''),
    createdAtMs: 0,
    isWorktreeRoot: false,
    /** Resolved AI for this folder, or empty when the user has defined no AI at all. */
    aiId: '',
    /** The repo's config `lastInteractedAtMs`. Only set on top-level repo targets. */
    lastInteractedAtMs: optionalShape(0, {
        alsoUndefined: true,
    }),
});

type RefreshTarget = typeof refreshTargetShape.runtimeType;

/**
 * Filesystem creation time, used by the sidebar's "Sort by date" option. `birthtimeMs` is 0 on
 * filesystems that don't record a creation time (notably older Linux ext4), so fall back to the
 * inode-change time, which for a freshly created directory is effectively its creation time. `0`
 * when the folder can't be stat'd, e.g. a configured repo whose directory was deleted.
 */
async function getCreatedAtMs(folder: string): Promise<number> {
    try {
        const stats = await stat(folder);
        return stats.birthtimeMs || stats.ctimeMs;
    } catch {
        return 0;
    }
}

async function enumerateTargets(config: Readonly<Config>): Promise<RefreshTarget[]> {
    const perRepo = await Promise.all(
        config.repos.map(async (repo): Promise<RefreshTarget[]> => {
            const isRoot = await isWorktreeRoot(repo.path);
            const createdAtMs = await getCreatedAtMs(repo.path);
            if (!isRoot) {
                return [
                    {
                        folder: repo.path,
                        parentRepoPath: null,
                        createdAtMs,
                        isWorktreeRoot: false,
                        lastInteractedAtMs: repo.lastInteractedAtMs,
                        aiId:
                            getFolderAiDefinition({
                                config,
                                folder: repo.path,
                            })?.id || '',
                    },
                ];
            }
            const children = await listWorktreeChildren(repo.path);
            return [
                {
                    folder: repo.path,
                    parentRepoPath: null,
                    createdAtMs,
                    isWorktreeRoot: true,
                    lastInteractedAtMs: repo.lastInteractedAtMs,
                    aiId:
                        getFolderAiDefinition({
                            config,
                            folder: repo.path,
                        })?.id || '',
                },
                ...(await Promise.all(
                    children.map(async (child): Promise<RefreshTarget> => {
                        return {
                            folder: child,
                            parentRepoPath: repo.path,
                            createdAtMs: await getCreatedAtMs(child),
                            isWorktreeRoot: false,
                            aiId:
                                getFolderAiDefinition({
                                    config,
                                    folder: child,
                                    fallbackFolders: [repo.path],
                                })?.id || '',
                        };
                    }),
                )),
            ];
        }),
    );
    return perRepo.flat();
}

async function buildFolderInfo({
    target,
    statusLookup,
    prRefreshTtl,
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    prRefreshTtl: AnyDuration | undefined;
}>): Promise<FolderInfo> {
    const git = await getGitInfo(target.folder);
    const pr = target.isWorktreeRoot
        ? null
        : await getCachedPrInfo(target.folder, git.branch, prRefreshTtl);
    if (pr) {
        markRepoHadPr(repoActivityKey(target));
    }
    return {
        ...placeholderFolderInfo(target),
        branch: git.branch,
        git: {
            dirty: git.dirty,
            notPushed: git.notPushed,
        },
        prUrl: pr?.url || null,
        prStatus: pr?.status || PrStatus.None,
        panes: mapEnumToObject(PaneKind, (kind) => statusLookup(target.folder, kind)),
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
        createdAtMs: target.createdAtMs,
        isWorktreeRoot: target.isWorktreeRoot,
        aiId: target.aiId,
        branch: null,
        git: {
            dirty: false,
            notPushed: false,
        },
        prUrl: null,
        prStatus: PrStatus.None,
        panes: mapEnumToObject(PaneKind, () => PaneStatus.None),
        /** Filled by the live overlay in {@link getCachedFolders}, not baked into the sweep's cache. */
        sessionStatuses: [],
        lastActivityAtMs: 0,
        /** Filled by the `/folders` endpoint, not baked into the sweep's cache. */
        watchMode: offWatchMode,
    };
}

/**
 * Pane status changes (Busy ↔ Idle) need to surface within a frontend poll, not within the slow
 * git-driven sweep cycle. Overlay live statuses from the daemon (briefly cached in
 * `getPaneStatusLookup`) on top of the cached FolderInfo so the sidebar's loader icon flips within
 * about one poll interval of the pane going busy, instead of waiting for the next sweep to bake the
 * new status into the cache.
 */
export async function getCachedFolders(): Promise<FolderInfo[]> {
    const statusLookup = await getPaneStatusLookup();
    const sessionStatusLookup = await getPaneSessionStatusLookup();
    return refreshState.targets.map((target) => {
        const base = cache.get(target.folder) || placeholderFolderInfo(target);
        return {
            ...base,
            panes: mapEnumToObject(PaneKind, (kind) => statusLookup(target.folder, kind)),
            sessionStatuses: [...sessionStatusLookup(target.folder)],
            /**
             * Overlaid like `sessionStatuses` rather than baked into the sweep's cache: a keystroke
             * has to move the sidebar's activity sort within a poll, not within a sweep. A repo
             * nobody has typed in yet falls back to when it was last opened or added, so a freshly
             * added repo sorts at the top instead of the end.
             */
            lastActivityAtMs:
                getFolderActivityAtMs(target.folder) || target.lastInteractedAtMs || 0,
        };
    });
}

/**
 * Folder-info cache file. Entries are left loose here and checked one by one against
 * {@link folderInfoShape} so a schema change (renamed/added field) drops only the stale entries
 * instead of poisoning the `/folders` response; the next sweep refills them.
 */
const persistedCacheShape = defineShape({
    targets: [
        unknownShape(),
    ],
    entries: [
        tupleShape('', unknownShape()),
    ],
});

/** GitHub cache file. PRs are checked one by one against {@link prInfoShape}, like the folder cache. */
const persistedGithubCacheShape = defineShape({
    repos: [
        tupleShape('', {
            fetchedAt: 0,
            prs: [
                tupleShape('', unknownShape()),
            ],
        }),
    ],
    /** Repo paths from {@link everHadPrRepoPaths}. */
    everHadPr: optionalShape(['']),
});

/**
 * Serializes each cache file's writes so a slow write can't land after, and overwrite, a newer
 * snapshot. Each snapshot is captured synchronously when the write is requested.
 */
const persistQueue = new PromiseQueue();

function persistJson(path: string, snapshot: unknown): void {
    const contents = JSON.stringify(snapshot);
    void persistQueue
        .add(async () => {
            await writeFileAtomically({
                path,
                contents,
            });
        })
        .catch((error: unknown) => {
            /** Best-effort: losing a write just means a cold restart. */
            log.warning(`Failed to write ${basename(path)}: ${extractErrorMessage(error)}`);
        });
}

function persistCache(): void {
    persistJson(folderInfoCachePath, {
        targets: [...refreshState.targets],
        entries: Array.from(cache.entries()),
    } satisfies typeof persistedCacheShape.runtimeType);
}

/** Reads a cache file, or undefined when it's missing or no longer matches `shape`. */
async function readPersistedJson<
    const SpecificShape extends Parameters<typeof parseJsonWithShape>[1],
>(path: string, shape: SpecificShape): Promise<SpecificShape['runtimeType'] | undefined> {
    const contents = await readFile(path, 'utf8').catch(() => undefined);
    try {
        return contents ? parseJsonWithShape(contents, shape) : undefined;
    } catch (error) {
        log.warning(
            `Ignoring unreadable ${basename(path)}; the live sweep rebuilds it: ${extractErrorMessage(error)}`,
        );
        return undefined;
    }
}

async function loadPersistedCache(): Promise<void> {
    const persisted = await readPersistedJson(folderInfoCachePath, persistedCacheShape);
    if (!persisted) {
        return;
    }
    refreshState.targets = persisted.targets.filter((target) => {
        return checkValidShape(target, refreshTargetShape);
    });
    persisted.entries.forEach(
        ([
            path,
            info,
        ]) => {
            if (!checkValidShape(info, folderInfoShape)) {
                return;
            }
            cache.set(path, info);
            /**
             * Seed the eligibility set from last session's markers. Without this, upgrading into
             * the eligibility rule would make every repo whose PRs are already known ineligible
             * until something made it active again.
             */
            if (info.prUrl) {
                everHadPrRepoPaths.add(info.parentRepoPath || info.path);
            }
        },
    );
}

function persistGithubCache(): void {
    persistJson(githubCachePath, {
        repos: Array.from(
            repoPrCache.entries(),
            ([
                key,
                entry,
            ]) => {
                return [
                    key,
                    {
                        fetchedAt: entry.fetchedAt,
                        prs: Array.from(entry.prsByBranch.entries()),
                    },
                ] as const;
            },
        ),
        everHadPr: Array.from(everHadPrRepoPaths),
    } satisfies typeof persistedGithubCacheShape.runtimeType);
}

async function loadPersistedGithubCache(): Promise<void> {
    const persisted = await readPersistedJson(githubCachePath, persistedGithubCacheShape);
    if (!persisted) {
        return;
    }
    persisted.repos.forEach(
        ([
            key,
            entry,
        ]) => {
            /**
             * Age is deliberately not checked. `fetchedAt` is carried through as-is so the TTL
             * tiers schedule a refresh, and until that refresh lands the sidebar shows last
             * session's PR markers instead of nothing.
             */
            repoPrCache.set(key, {
                fetchedAt: entry.fetchedAt,
                prsByBranch: new Map(
                    entry.prs.filter(
                        (
                            prEntry,
                        ): prEntry is [
                            string,
                            PrInfo,
                        ] => checkValidShape(prEntry[1], prInfoShape),
                    ),
                ),
            });
        },
    );
    (persisted.everHadPr || []).forEach((repoPath) => {
        everHadPrRepoPaths.add(repoPath);
    });
}

/**
 * Pause between consecutive folder refreshes within a sweep. Each folder costs a handful of git
 * subprocesses (`rev-parse`, `status --porcelain`, upstream check, `log` ahead-count); spreading
 * them out keeps the backend from pegging a core when the user has many configured repos.
 */
const perFolderDelay: AnyDuration = {
    milliseconds: 100,
};
/**
 * Idle pause after each complete sweep through every folder. Short enough that the sidebar's `*` /
 * `+` markers reflect dirty / not pushed state soon after git activity. PR fetches piggy-back on
 * this sweep but are gated by {@link hotRepoPrTtl} / {@link coldRepoPrTtl}, so a faster sweep does
 * not mean more GitHub traffic.
 */
const sweepIdle: AnyDuration = {
    seconds: 5,
};

/**
 * The last refresh error logged per folder, so a repo that keeps failing logs once rather than on
 * every sweep.
 */
const loggedRefreshErrors = new Map<string, string>();

const folderPrHooks: {
    onNewPr: ((info: Readonly<FolderInfo>) => void) | undefined;
} = {
    onNewPr: undefined,
};

/**
 * Calls `listener` when a sweep finds a PR on a folder whose previous sweep found none. A folder's
 * first sweep never counts, so a newly added folder whose branch already has a PR doesn't trigger
 * it. Replaces any earlier listener.
 */
export function listenToNewFolderPrs(listener: (info: Readonly<FolderInfo>) => void) {
    folderPrHooks.onNewPr = listener;
}

async function refreshOnce({
    target,
    statusLookup,
    prRefreshTtl,
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    prRefreshTtl: AnyDuration | undefined;
}>): Promise<void> {
    try {
        const info = await buildFolderInfo({
            target,
            statusLookup,
            prRefreshTtl,
        });
        loggedRefreshErrors.delete(target.folder);
        const previous = cache.get(target.folder);
        cache.set(target.folder, info);
        persistCache();
        if (previous && !previous.prUrl && info.prUrl) {
            folderPrHooks.onNewPr?.(info);
        }
    } catch (error) {
        /** Swallowed so one bad repo doesn't stop the sweep. */
        const message = extractErrorMessage(error);
        if (loggedRefreshErrors.get(target.folder) !== message) {
            loggedRefreshErrors.set(target.folder, message);
            log.warning(`Failed to refresh ${target.folder}: ${message}`);
        }
    }
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

/**
 * Decide, per repo, how stale its PR map may get before a sweep re-fetches it — or `undefined` for
 * "never re-fetch this one".
 *
 * A repo earns a GraphQL call only if one of three things is true:
 *
 * 1. It's active — a live AI/Shell pane, or activated within {@link recentInteraction}. This is the
 *    server-side stand-in for "the folder the user has selected", which the backend can't see
 *    directly (the selection lives in the frontend URL).
 * 2. It has worktrees, meaning the group is a worktree-root and its children. Worktree-per-branch is
 *    the PR workflow, so these always qualify.
 * 3. It has produced a PR before — see {@link everHadPrRepoPaths}.
 *
 * A plain repo with no worktrees that has never shown a PR is skipped entirely. Nothing about it
 * would ever render a PR marker, so the call would only spend rate limit.
 *
 * On top of eligibility, a repo the sidebar isn't rendering is skipped too. That mirrors the "Hide
 * Inactive" rule (`filterByRecency` in `vir-sidebar.element.ts`) and reads the same inputs, all of
 * which are already server-side. The sidebar's search box is deliberately ignored — it's transient,
 * and it only ever widens what's on screen.
 *
 * Exported for tests.
 */
export function computeRepoPrRefreshTtlByRepo({
    targets,
    statusLookup,
    repos,
    onlyShowRecent,
    everHadPrPaths,
    nowMs,
}: Readonly<{
    targets: ReadonlyArray<RefreshTarget>;
    statusLookup: PaneStatusLookup;
    repos: ReadonlyArray<RepoConfig>;
    onlyShowRecent: boolean;
    everHadPrPaths: ReadonlySet<string>;
    nowMs: number;
}>): Map<string, AnyDuration | undefined> {
    const groupKeys = Array.from(new Set(targets.map(repoActivityKey)));
    return new Map(
        groupKeys.map((key) => {
            const groupTargets = targets.filter((target) => repoActivityKey(target) === key);
            const hasLivePane = groupTargets.some((target) => {
                return getEnumValues(PaneKind).some(
                    (kind) => livePaneStatuses[statusLookup(target.folder, kind)],
                );
            });
            const isWorktreeGroup = groupTargets.some(
                (target) => target.isWorktreeRoot || !!target.parentRepoPath,
            );
            const msSinceInteraction =
                nowMs - (repos.find((repo) => repo.path === key)?.lastInteractedAtMs || 0);
            const isActive =
                hasLivePane ||
                msSinceInteraction <
                    convertDuration(recentInteraction, {
                        milliseconds: true,
                    }).milliseconds;
            const isEligible = isActive || isWorktreeGroup || everHadPrPaths.has(key);
            const isVisible =
                !onlyShowRecent ||
                isWorktreeGroup ||
                hasLivePane ||
                msSinceInteraction <
                    convertDuration(sidebarRecencyWindow, {
                        milliseconds: true,
                    }).milliseconds;
            if (!isEligible || !isVisible) {
                return [
                    key,
                    undefined,
                ];
            }
            return [
                key,
                isActive ? hotRepoPrTtl : coldRepoPrTtl,
            ];
        }),
    );
}

async function runSweep(): Promise<void> {
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return;
    }
    await clearExpiredAutoDisable();
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
     * Snapshot each repo's PR refresh interval at sweep start. Whatever is already cached is served
     * regardless; this only decides which repos spend a GraphQL call this time around.
     */
    const prRefreshTtlByRepo = computeRepoPrRefreshTtlByRepo({
        targets,
        statusLookup,
        repos: config.repos,
        onlyShowRecent: !!config.onlyShowRecent,
        everHadPrPaths: everHadPrRepoPaths,
        nowMs: Date.now(),
    });
    /**
     * Sequential on purpose: parallel refresh is what created the original 100% CPU problem.
     * `awaitedForEach` awaits each callback before invoking the next, so subprocess pressure stays
     * at one folder at a time.
     */
    await awaitedForEach(targets, async (target) => {
        await refreshOnce({
            target,
            statusLookup,
            /** Disabled polling still serves the cached PRs. It only skips fetching new ones. */
            prRefreshTtl: disabledGitHubPolling
                ? undefined
                : prRefreshTtlByRepo.get(repoActivityKey(target)),
        });
        await wait(perFolderDelay);
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
    void runSweep().catch(logSweepFailure);
}

/** Never let a sweep failure crash the process or end the loop; the next sweep tries again. */
function logSweepFailure(error: unknown): void {
    log.warning(`Folder sweep failed: ${extractErrorMessage(error)}`);
}

/**
 * Schedules the next sweep {@link sweepIdle} after the current one finishes. Recursive `setTimeout`
 * rather than `setInterval` so sweeps never overlap if one runs long.
 */
function scheduleNextSweep(): void {
    setTimeout(
        () => {
            runSweep().catch(logSweepFailure).finally(scheduleNextSweep);
        },
        convertDuration(sweepIdle, {
            milliseconds: true,
        }).milliseconds,
    );
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
    runSweep().catch(logSweepFailure).finally(scheduleNextSweep);
}
