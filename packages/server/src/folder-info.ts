import {
    aiDefinitionShape,
    folderInfoShape,
    ForgeType,
    GitHubPollingDisableReason,
    PaneKind,
    PaneStatus,
    PrStatus,
    WatchModeStatus,
    type FolderInfo,
    type SavedRepo,
    type Settings,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
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
import {loadAppState, updateAppState, type AppState} from './app-state.js';
import {repoCacheKey, repoPrCache} from './branch-prs.js';
import {folderInfoCachePath, githubCachePath} from './file-paths.js';
import {getFolderActivityAtMs} from './folder-activity.js';
import {loadFolderSettings} from './folder-settings.js';
import {
    fetchRepoPrs,
    forgetGitInfo,
    getGitInfo,
    getRepoSlug,
    GitHubPollingError,
    isWorktreeRoot,
    listenToGitInfoChanges,
    listWorktreeChildren,
    prInfoShape,
    type PrInfo,
    type RepoSlug,
} from './git.js';
import {applyManualReviewStatus} from './github-review-queue.js';
import {normalizePath} from './paths.js';
import {getPaneSessionStatusLookup, getPaneStatusLookup} from './pty.js';
import {loadSettings, resolveFolderAi} from './settings.js';
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
 * failure; GitHub calls are skipped until `disabledUntilMs` elapses. Persisted to the app state so
 * `tsx --watch` restarts during dev don't immediately re-poll GitHub and hit the same rate limit
 * again. The user's explicit `forges.github.disabledGitHubPolling` setting takes precedence either
 * way; this only flips an implicit off-switch.
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

/** Forgets an auto-disable whose backoff has run out, so the app state stops carrying it. */
async function clearExpiredAutoDisable(): Promise<void> {
    if (githubPollingState.autoDisable && !isAutoDisabled()) {
        githubPollingState.autoDisable = undefined;
        await persistAutoDisable();
    }
}

async function persistAutoDisable(): Promise<void> {
    await updateAppState((state) => {
        return {
            ...state,
            githubPollingAutoDisable: githubPollingState.autoDisable || null,
        };
    }).catch((error: unknown) => {
        log.warning(`Failed to save GitHub polling auto-disable: ${extractErrorMessage(error)}`);
    });
}

function loadSavedAutoDisable(state: Readonly<AppState>): void {
    const saved = state.githubPollingAutoDisable;
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
    void persistAutoDisable();
}

function isGitHubPollingDisabled(settings: Readonly<Settings>): boolean {
    return settings.forges[ForgeType.Github].disabledGitHubPolling || isAutoDisabled();
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
    const slug = await getRepoSlug(folder);
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
    /** Resolved AI for this folder, or empty when no AI is defined at all. */
    aiId: '',
    inheritedAiId: '',
    folderAiDefinitions: [aiDefinitionShape],
    /** The saved repo's `lastInteractedAtMs`. Only set on top-level repo targets. */
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

/** The AI fields of a folder's {@link RefreshTarget}. */
async function resolveTargetAi({
    settings,
    folder,
    fallbackFolders,
}: Readonly<{
    settings: Readonly<Settings>;
    folder: string;
    fallbackFolders?: ReadonlyArray<string> | undefined;
}>) {
    const resolved = resolveFolderAi({
        settings,
        folderLayers: await loadFolderSettings(folder),
        folder,
        fallbackFolders,
    });
    return {
        aiId: resolved.ai?.id || '',
        inheritedAiId: resolved.inheritedAi?.id || '',
        folderAiDefinitions: resolved.aiDefinitions.filter((definition) => {
            return !settings.aiDefinitions.some((own) => own.id === definition.id);
        }),
    };
}

async function enumerateTargets({
    settings,
    repos,
}: Readonly<{
    settings: Readonly<Settings>;
    repos: ReadonlyArray<SavedRepo>;
}>): Promise<RefreshTarget[]> {
    const perRepo = await Promise.all(
        repos.map(async (repo): Promise<RefreshTarget[]> => {
            const isRoot = await isWorktreeRoot(repo.path);
            const rootTarget: RefreshTarget = {
                folder: repo.path,
                parentRepoPath: null,
                createdAtMs: await getCreatedAtMs(repo.path),
                isWorktreeRoot: isRoot,
                lastInteractedAtMs: repo.lastInteractedAtMs,
                ...(await resolveTargetAi({
                    settings,
                    folder: repo.path,
                })),
            };
            if (!isRoot) {
                return [
                    rootTarget,
                ];
            }
            const children = await listWorktreeChildren(repo.path);
            return [
                rootTarget,
                ...(await Promise.all(
                    children.map(async (child): Promise<RefreshTarget> => {
                        return {
                            folder: child,
                            parentRepoPath: repo.path,
                            createdAtMs: await getCreatedAtMs(child),
                            isWorktreeRoot: false,
                            ...(await resolveTargetAi({
                                settings,
                                folder: child,
                                fallbackFolders: [repo.path],
                            })),
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
 * the iteration order of the saved repos + their worktree children, so consumers can render without
 * re-sorting.
 */
const cache = new Map<string, FolderInfo>();
/**
 * Mutable module-level state for the refresh loop. Kept on a single object so we can avoid `let`
 * for each field. `targets` is the most recent enumeration result; the endpoint walks it to emit
 * folders in saved-repo order, falling back to a git-less placeholder for any target the background
 * sweep hasn't refreshed yet. `loopStarted` guards `startFolderInfoRefreshLoop` against being
 * called twice.
 */
const refreshState: {
    targets: ReadonlyArray<RefreshTarget>;
    loopStarted: boolean;
    /** Whether `cache` changed since it was last written to disk. */
    hasUnsavedChanges: boolean;
    /** The folder the sweep is rebuilding, which needs no separate rebuild for its git changes. */
    sweepingFolder: string | undefined;
} = {
    targets: [],
    loopStarted: false,
    hasUnsavedChanges: false,
    sweepingFolder: undefined,
};

/** When each folder's git state was last read, which is what spaces out refreshes of idle folders. */
const lastRefreshedAtMsByFolder = new Map<string, number>();

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
        inheritedAiId: target.inheritedAiId,
        folderAiDefinitions: target.folderAiDefinitions,
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
/**
 * The repo `folder` is a worktree of, per the last sweep. Undefined for a repo or an unknown
 * folder.
 */
export function findParentRepoPath(folder: string) {
    const normalizedFolder = normalizePath(folder);
    return (
        refreshState.targets.find((target) => target.folder === normalizedFolder)?.parentRepoPath ||
        undefined
    );
}

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
 * Pause between consecutive folder refreshes within a sweep. Each folder costs a `git status`, plus
 * a `rev-list` when the branch has no upstream; spreading them out keeps the backend from pegging a
 * core when the user has many configured repos.
 */
const perFolderDelay: AnyDuration = {
    milliseconds: 100,
};
/**
 * Idle pause after each complete sweep. Short enough that the sidebar's `*` / `+` markers reflect
 * dirty / not pushed state soon after git activity in a folder being worked in. PR fetches
 * piggy-back on this sweep but are gated by {@link hotRepoPrTtl} / {@link coldRepoPrTtl}, so a faster
 * sweep does not mean more GitHub traffic.
 */
const sweepIdle: AnyDuration = {
    seconds: 5,
};

/**
 * How often a sweep re-reads a folder nobody is working in. Only something outside agent-storm (an
 * editor, another terminal) changes such a folder, so its markers may lag a little in exchange for
 * not running git in every configured folder on every sweep.
 */
const idleFolderRefreshInterval: AnyDuration = {
    minutes: 2,
};

/**
 * Whether a sweep re-reads this folder's git state: always for a folder never read yet, one with a
 * live pane, or one typed in or activated recently, and otherwise once
 * {@link idleFolderRefreshInterval} has passed. Exported for tests.
 */
export function isFolderRefreshDue({
    target,
    statusLookup,
    repos,
    folderActivityAtMs,
    lastRefreshedAtMs,
    nowMs,
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    repos: ReadonlyArray<SavedRepo>;
    folderActivityAtMs: number;
    lastRefreshedAtMs: number | undefined;
    nowMs: number;
}>) {
    if (lastRefreshedAtMs == undefined) {
        return true;
    }
    const hasLivePane = getEnumValues(PaneKind).some(
        (kind) => livePaneStatuses[statusLookup(target.folder, kind)],
    );
    const lastInteractedAtMs =
        repos.find((repo) => repo.path === repoActivityKey(target))?.lastInteractedAtMs || 0;
    return (
        hasLivePane ||
        nowMs - Math.max(folderActivityAtMs, lastInteractedAtMs) <
            convertDuration(recentInteraction, {
                milliseconds: true,
            }).milliseconds ||
        nowMs - lastRefreshedAtMs >=
            convertDuration(idleFolderRefreshInterval, {
                milliseconds: true,
            }).milliseconds
    );
}

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
    /** Stamped up front so a failing folder waits like any other instead of retrying every sweep. */
    lastRefreshedAtMsByFolder.set(target.folder, Date.now());
    refreshState.sweepingFolder = target.folder;
    try {
        storeFolderInfo(
            await buildFolderInfo({
                target,
                statusLookup,
                prRefreshTtl,
            }),
        );
        loggedRefreshErrors.delete(target.folder);
    } catch (error) {
        /** Swallowed so one bad repo doesn't stop the sweep. */
        const message = extractErrorMessage(error);
        if (loggedRefreshErrors.get(target.folder) !== message) {
            loggedRefreshErrors.set(target.folder, message);
            log.warning(`Failed to refresh ${target.folder}: ${message}`);
        }
    } finally {
        refreshState.sweepingFolder = undefined;
    }
}

function storeFolderInfo(info: Readonly<FolderInfo>) {
    const previous = cache.get(info.path);
    if (!check.deepEquals(previous, info)) {
        cache.set(info.path, info);
        refreshState.hasUnsavedChanges = true;
    }
    if (previous && !previous.prUrl && info.prUrl) {
        folderPrHooks.onNewPr?.(info);
    }
}

/**
 * Rebuilds a folder whose git state changed in a read outside the sweep, so the sidebar shows it
 * without waiting for the sweep to come around. Serves only cached PRs and the panes already shown,
 * so it never calls GitHub or the daemon.
 */
async function applyGitInfoChange(folder: string) {
    const target = refreshState.targets.find((each) => normalizePath(each.folder) === folder);
    const previous = target && cache.get(target.folder);
    if (!target || !previous || refreshState.sweepingFolder === target.folder) {
        return;
    }
    try {
        storeFolderInfo(
            await buildFolderInfo({
                target,
                statusLookup(_folder, kind) {
                    return previous.panes[kind];
                },
                prRefreshTtl: undefined,
            }),
        );
    } catch (error) {
        log.warning(`Failed to update ${folder}: ${extractErrorMessage(error)}`);
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
    repos: ReadonlyArray<SavedRepo>;
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

/** The settings and repo list a sweep needs, or undefined when either can't be read. */
async function loadSweepInputs() {
    const [
        settings,
        appState,
    ] = await Promise.all([
        loadSettings().catch(() => undefined),
        loadAppState().catch(() => undefined),
    ]);
    return (
        settings &&
        appState && {
            settings,
            repos: appState.repos,
        }
    );
}

async function runSweep(): Promise<void> {
    const sweepInputs = await loadSweepInputs();
    if (!sweepInputs) {
        return;
    }
    await clearExpiredAutoDisable();
    const targets = await enumerateTargets(sweepInputs);
    const haveTargetsChanged = !check.deepEquals(refreshState.targets, targets);
    /**
     * Publish the target list before the slow per-folder loop runs so `/folders` can return
     * placeholders for every configured folder immediately, without waiting for git to finish.
     */
    refreshState.targets = targets;
    if (haveTargetsChanged) {
        persistCache();
    }
    const statusLookup = await getPaneStatusLookup();
    const disabledGitHubPolling = isGitHubPollingDisabled(sweepInputs.settings);
    /**
     * Snapshot each repo's PR refresh interval at sweep start. Whatever is already cached is served
     * regardless; this only decides which repos spend a GraphQL call this time around.
     */
    const prRefreshTtlByRepo = computeRepoPrRefreshTtlByRepo({
        targets,
        statusLookup,
        repos: sweepInputs.repos,
        onlyShowRecent: !!sweepInputs.settings.onlyShowRecent,
        everHadPrPaths: everHadPrRepoPaths,
        nowMs: Date.now(),
    });
    /**
     * Sequential on purpose: parallel refresh is what created the original 100% CPU problem.
     * `awaitedForEach` awaits each callback before invoking the next, so subprocess pressure stays
     * at one folder at a time.
     */
    await awaitedForEach(targets, async (target) => {
        if (
            !isFolderRefreshDue({
                target,
                statusLookup,
                repos: sweepInputs.repos,
                folderActivityAtMs: getFolderActivityAtMs(target.folder),
                lastRefreshedAtMs: lastRefreshedAtMsByFolder.get(target.folder),
                nowMs: Date.now(),
            })
        ) {
            return;
        }
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
    stale.forEach((path) => {
        cache.delete(path);
        lastRefreshedAtMsByFolder.delete(path);
        forgetGitInfo(path);
    });
    /** Once per sweep rather than per folder: each write is the whole cache. */
    if (stale.length > 0 || refreshState.hasUnsavedChanges) {
        refreshState.hasUnsavedChanges = false;
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
    const sweepInputs = await loadSweepInputs();
    if (!sweepInputs) {
        return;
    }
    refreshState.targets = await enumerateTargets(sweepInputs);
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
    const initialState = await loadAppState().catch(() => undefined);
    if (initialState) {
        loadSavedAutoDisable(initialState);
    }
    listenToGitInfoChanges(async ({folder}) => {
        await applyGitInfoChange(folder);
    });
    runSweep().catch(logSweepFailure).finally(scheduleNextSweep);
}
