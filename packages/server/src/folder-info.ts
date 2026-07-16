import {
    PaneKind,
    PaneStatus,
    type Config,
    type FolderInfo,
} from '@agent-storm/common';
import {awaitedForEach, log, wait} from '@augment-vir/common';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {getFolderAiCmd, getFolderResetAiSessionCmd, loadConfig, saveConfig} from './config.js';
import {folderInfoCachePath, githubCachePath, notCommittedDir} from './file-paths.js';
import {
    fetchPrInfoForBranch,
    fetchRepoPrs,
    getGitInfo,
    getRepoSlug,
    GitHubPollingError,
    hasUncommittedChanges,
    type GitHubPollingDisableReason,
    type PrInfo,
    type RepoSlug,
} from './git.js';
import {getPaneStatusLookup} from './pty.js';
import {reconcileConfig} from './worktree-reconcile.js';

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
    /**
     * Branches we've already looked up during this cache window (either via the batch fetch
     * or the per-branch fallback). Used to short-circuit `fetchPrInfoForBranch` for branches
     * confirmed to have no PR — otherwise every sweep would re-shell `gh pr view` for a worktree
     * with no PR, wasting subprocess time and rate-limit budget. Reset on each new batch fetch
     * so a freshly-created PR is picked up within one cache TTL.
     */
    checkedBranches: Set<string>;
};

/**
 * Outcome of a PR lookup. `authoritative: true` means GitHub gave us a current answer
 * (found the PR, or confirmed there's no PR for this branch) — `info: null` here means
 * "no PR exists" and the caller should clear any stale UI badges. `authoritative: false`
 * means we couldn't query GitHub (polling disabled, no active pane and cache stale, network
 * blip) — the caller should preserve whatever PR snapshot it last saw rather than wiping
 * the sidebar's open-PR / draft / CI badges.
 */
type PrLookupResult = {
    info: PrInfo | null;
    authoritative: boolean;
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
 * config is still the source of truth — this is just a hot cache so `getOrFetchRepoCacheEntry` can gate
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

/**
 * Resolve the per-repo cache entry, refreshing from GitHub when stale and allowed. Returns
 * the cached entry alongside an `isFresh` flag so the caller can tell "we just fetched this"
 * from "we're serving stale data because we couldn't refresh." Returns `null` only when there
 * is no cached data at all and we couldn't fetch — that's the case where the caller must
 * preserve the prior FolderInfo snapshot to avoid wiping the sidebar.
 *
 * Stale-but-cached data is still returned (with `isFresh: false`) on inactive panes,
 * auto-disable backoff, and benign fetch failures. The previous behavior dropped to an empty
 * map any time a fresh fetch couldn't run, which is what was causing the sidebar's PR badges
 * to vanish whenever the user closed all Claude panes.
 */
async function getOrFetchRepoCacheEntry(
    slug: Readonly<RepoSlug>,
    allowFetch: boolean,
): Promise<{entry: RepoPrCacheEntry; isFresh: boolean} | null> {
    if (isUserPollingDisabled()) {
        const existing = repoPrCache.get(repoCacheKey(slug));
        return existing ? {entry: existing, isFresh: false} : null;
    }
    const key = repoCacheKey(slug);
    const existing = repoPrCache.get(key);
    if (existing && Date.now() - existing.fetchedAt < repoPrCacheTtlMs) {
        return {entry: existing, isFresh: true};
    }
    /**
     * Stale or missing. The caller-decided activity gate and the auto-disable backoff both
     * mean "don't pay for a fresh fetch right now" — but we still want the caller to see
     * whatever we last had, so the sidebar's PR badges survive an idle period or a transient
     * auth blip. Empty Map is only returned when there's literally nothing cached yet.
     */
    if (!allowFetch || isAutoDisabled()) {
        return existing ? {entry: existing, isFresh: false} : null;
    }
    try {
        const prsByBranch = await fetchRepoPrs(slug);
        const entry: RepoPrCacheEntry = {
            fetchedAt: Date.now(),
            prsByBranch,
            /**
             * Seed `checkedBranches` with every branch returned by the batch. Subsequent
             * fallbacks add to this set so a branch confirmed-no-PR isn't re-checked every
             * sweep until the next batch refresh.
             */
            checkedBranches: new Set(prsByBranch.keys()),
        };
        repoPrCache.set(key, entry);
        persistGithubCache();
        return {entry, isFresh: true};
    } catch (error) {
        if (error instanceof GitHubPollingError) {
            markAutoDisabled(error.reason, error.message);
        }
        return existing ? {entry: existing, isFresh: false} : null;
    }
}

async function getCachedPrInfo(
    folder: string,
    branch: string | null,
    allowFetch: boolean,
): Promise<PrLookupResult> {
    if (!branch) {
        /** No branch = no PR possible; authoritative. */
        return {info: null, authoritative: true};
    }
    const slug = await ensureRepoSlug(folder);
    if (!slug) {
        /** Not a GitHub repo; authoritative. */
        return {info: null, authoritative: true};
    }
    const result = await getOrFetchRepoCacheEntry(slug, allowFetch);
    if (!result) {
        /** No cache and couldn't fetch — preserve whatever the caller last knew. */
        return {info: null, authoritative: false};
    }
    const {entry, isFresh} = result;
    const hit = entry.prsByBranch.get(branch);
    if (hit) {
        return {info: hit, authoritative: true};
    }
    /**
     * Branch not in the batch. Two cases: we've already fallen back for this branch in the
     * current cache window (or it was just confirmed missing from a fresh batch we seeded
     * `checkedBranches` from) → authoritative no-PR. Otherwise we need to fall back via
     * `gh pr view` if we're allowed.
     */
    if (entry.checkedBranches.has(branch)) {
        return {info: null, authoritative: true};
    }
    if (!isFresh || !allowFetch || isAutoDisabled()) {
        /** Couldn't confirm — preserve prior. */
        return {info: null, authoritative: false};
    }
    try {
        const info = await fetchPrInfoForBranch(folder, branch);
        entry.checkedBranches.add(branch);
        if (info) {
            entry.prsByBranch.set(branch, info);
        }
        persistGithubCache();
        return {info, authoritative: true};
    } catch (error) {
        if (error instanceof GitHubPollingError) {
            markAutoDisabled(error.reason, error.message);
        }
        return {info: null, authoritative: false};
    }
}

type RefreshTarget = {
    folder: string;
    parentRepoPath: string | null;
    isWorktreeRoot: boolean;
    /**
     * Whether the target tracks the parent repo's base branch. Pulled from
     * `config.repos[].worktrees[].isBase` so we know up-front — without running git — that the
     * placeholder for this folder should report `isBaseBranch: true` and be hidden from the
     * sidebar. The previous design left `isBase` undecidable until the background sweep had
     * read each worktree's branch, which made the base worktree visible for one sweep cycle
     * after adding a repo.
     */
    isBase: boolean;
    baseBranch: string | null;
    aiHidden: boolean;
    /** Resolved effective AI command for this folder (per-folder override → global default). */
    aiCmd: string;
    /** Resolved effective reset-AI-session command for this folder; empty when none configured. */
    resetAiSessionCmd: string;
    /**
     * Whether the user marked this worktree as hidden via the row's three-dot menu. Mirrored
     * from `config.hiddenWorktrees` so the sidebar's "Show hidden" filter can decide whether
     * to render this row.
     */
    isHidden: boolean;
    /**
     * Whether the user moved this folder to the sidebar's "Do later" section via the row's
     * three-dot menu. Mirrored from `config.doLaterFolders`; unlike `isHidden` the row stays
     * visible, just regrouped.
     */
    doLater: boolean;
    /**
     * SHA captured the last time the user checked Self-review (code) on this worktree, mirrored
     * from `worktreeConfigShape.lastReviewedSha`. Lifted into the target up-front so the progress
     * tracker can show the right state on the very first render — before any sweep has built a
     * full `FolderInfo` — and so the placeholder doesn't drop a previously-checked review back
     * to undefined whenever the cache is cold.
     */
    lastReviewedSha: string | null;
    /**
     * Per-step booleans for the progress tracker's user-toggled merge steps, mirrored from
     * `worktreeConfigShape.mergeStepValues`. Same up-front-lift rationale as `lastReviewedSha`:
     * the tracker reads this before any sweep has run, so a freshly-loaded session shows the
     * persisted check state immediately rather than first rendering everything as unchecked.
     */
    mergeStepValues: Partial<Record<string, boolean>>;
};

function enumerateTargets(config: Readonly<Config>): RefreshTarget[] {
    return config.repos.flatMap((repo): RefreshTarget[] => {
        if (!repo.isWorktreeLayout) {
            return [
                {
                    folder: repo.path,
                    parentRepoPath: null,
                    isWorktreeRoot: false,
                    isBase: false,
                    baseBranch: null,
                    aiHidden: config.hiddenAiPane.includes(repo.path),
                    aiCmd: getFolderAiCmd({
                        config,
                        folder: repo.path,
                    }),
                    resetAiSessionCmd: getFolderResetAiSessionCmd({
                        config,
                        folder: repo.path,
                    }),
                    isHidden: false,
                    doLater: false,
                    lastReviewedSha: null,
                    mergeStepValues: {},
                },
            ];
        }
        return [
            {
                folder: repo.path,
                parentRepoPath: null,
                isWorktreeRoot: true,
                isBase: false,
                baseBranch: null,
                aiHidden: false,
                aiCmd: getFolderAiCmd({
                    config,
                    folder: repo.path,
                }),
                resetAiSessionCmd: getFolderResetAiSessionCmd({
                    config,
                    folder: repo.path,
                }),
                isHidden: false,
                doLater: false,
                lastReviewedSha: null,
                mergeStepValues: {},
            },
            ...repo.worktrees.map(
                (worktree): RefreshTarget => ({
                    folder: worktree.path,
                    parentRepoPath: repo.path,
                    isWorktreeRoot: false,
                    isBase: worktree.isBase,
                    baseBranch: repo.baseBranch ?? null,
                    aiHidden: config.hiddenAiPane.includes(worktree.path),
                    aiCmd: getFolderAiCmd({
                        config,
                        folder: worktree.path,
                        fallbackFolders: [repo.path],
                    }),
                    resetAiSessionCmd: getFolderResetAiSessionCmd({
                        config,
                        folder: worktree.path,
                        fallbackFolders: [repo.path],
                    }),
                    isHidden: config.hiddenWorktrees.includes(worktree.path),
                    doLater: config.doLaterFolders.includes(worktree.path),
                    lastReviewedSha: worktree.lastReviewedSha ?? null,
                    mergeStepValues: worktree.mergeStepValues ?? {},
                }),
            ),
        ];
    });
}

type PrSnapshot = Pick<
    FolderInfo,
    | 'prUrl'
    | 'prMerged'
    | 'branchCommitHash'
    | 'prIsDraft'
    | 'prCiPassing'
    | 'prCiInProgress'
    | 'prReviewCheckPassing'
    | 'prReviewCheckInProgress'
    | 'prApproved'
    | 'prReviewChangesRequested'
    | 'prReviewPending'
    | 'prHasUnresolvedReviewComments'
    | 'prHasMergeConflicts'
>;

const emptyPrSnapshot: PrSnapshot = {
    prUrl: null,
    prMerged: false,
    branchCommitHash: null,
    prIsDraft: false,
    prCiPassing: null,
    prCiInProgress: false,
    prReviewCheckPassing: null,
    prReviewCheckInProgress: false,
    prApproved: false,
    prReviewChangesRequested: false,
    prReviewPending: false,
    prHasUnresolvedReviewComments: false,
    prHasMergeConflicts: false,
};

function prSnapshotFromPr(pr: Readonly<PrInfo>): PrSnapshot {
    return {
        prUrl: pr.url || null,
        prMerged: pr.merged,
        branchCommitHash: pr.headRefOid || null,
        prIsDraft: pr.isDraft,
        prCiPassing: pr.ciPassing,
        prCiInProgress: pr.ciInProgress,
        prReviewCheckPassing: pr.reviewCheckPassing,
        prReviewCheckInProgress: pr.reviewCheckInProgress,
        prApproved: pr.approved,
        prReviewChangesRequested: pr.reviewChangesRequested,
        prReviewPending: pr.reviewPending,
        prHasUnresolvedReviewComments: pr.hasUnresolvedReviewComments,
        // `?? false` guards PrInfo rehydrated from github-cache.json that predates this field —
        // without it `/folders` emits `prHasMergeConflicts: undefined` and fails outgoing-shape
        // validation until the branch's PR is next fetched fresh from GitHub.
        prHasMergeConflicts: pr.hasMergeConflicts ?? false,
    };
}

function prSnapshotFromPrior(prior: Readonly<FolderInfo>): PrSnapshot {
    return {
        prUrl: prior.prUrl,
        prMerged: prior.prMerged,
        branchCommitHash: prior.branchCommitHash,
        prIsDraft: prior.prIsDraft,
        prCiPassing: prior.prCiPassing,
        prCiInProgress: prior.prCiInProgress,
        prReviewCheckPassing: prior.prReviewCheckPassing,
        prReviewCheckInProgress: prior.prReviewCheckInProgress,
        prApproved: prior.prApproved,
        prReviewChangesRequested: prior.prReviewChangesRequested,
        prReviewPending: prior.prReviewPending,
        prHasUnresolvedReviewComments: prior.prHasUnresolvedReviewComments,
        prHasMergeConflicts: prior.prHasMergeConflicts,
    };
}

async function buildFolderInfo({
    target,
    statusLookup,
    disabledGitHubPolling,
    repoHasActivePane,
    prior,
}: Readonly<{
    target: RefreshTarget;
    statusLookup: PaneStatusLookup;
    disabledGitHubPolling: boolean;
    repoHasActivePane: boolean;
    prior: FolderInfo | undefined;
}>): Promise<FolderInfo> {
    const git = await getGitInfo(target.folder);
    /**
     * Worktree roots are bare and never have a PR — short-circuit to an authoritative empty.
     * User-disabled polling or auto-disable backoff means no GitHub call ran this sweep —
     * treat as non-authoritative so the prior snapshot carries forward instead of nulling
     * out badges. Everything else goes through the per-repo cache lookup.
     */
    const prLookup: PrLookupResult = target.isWorktreeRoot
        ? {info: null, authoritative: true}
        : disabledGitHubPolling
          ? {info: null, authoritative: false}
          : await getCachedPrInfo(target.folder, git.branch, repoHasActivePane);
    /**
     * Tri-state branch:
     *   found → fresh snapshot from the PR.
     *   authoritative miss → GitHub confirmed no PR; clear stale UI badges.
     *   non-authoritative → couldn't query (inactive pane + stale cache, disabled polling,
     *     fetch error); keep showing the last-known snapshot so the sidebar doesn't blank.
     */
    const prSnapshot: PrSnapshot = prLookup.info
        ? prSnapshotFromPr(prLookup.info)
        : prLookup.authoritative
          ? emptyPrSnapshot
          : prior
            ? prSnapshotFromPrior(prior)
            : emptyPrSnapshot;
    return {
        path: target.folder,
        name: basename(target.folder),
        parentRepoPath: target.parentRepoPath,
        isWorktreeRoot: target.isWorktreeRoot,
        isBaseBranch: target.isBase,
        aiHidden: target.aiHidden,
        aiCmd: target.aiCmd,
        resetAiSessionCmd: target.resetAiSessionCmd,
        isHidden: target.isHidden,
        doLater: target.doLater,
        branch: git.branch,
        git: {
            dirty: git.dirty,
            notPushed: git.notPushed,
        },
        hasUncommittedChanges: git.dirty,
        localCommitHash: git.localCommitHash,
        ...prSnapshot,
        lastReviewedSha: target.lastReviewedSha,
        mergeStepValues: target.mergeStepValues,
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
 * Last fetched pane-status snapshot from the daemon, refreshed on a dedicated 1s ticker
 * independent of the slow git/PR sweep. `getCachedFolders` overlays this onto each emitted
 * FolderInfo so the sidebar's Working / Needs-attention grouping reflects the live state of
 * each Claude pty rather than whatever was true at the last full sweep (up to ~25s stale).
 */
const livePaneStatus: {
    lookup: (folder: string, kind: PaneKind) => PaneStatus;
} = {
    lookup: () => PaneStatus.None,
};

/**
 * Per-folder dirty-tree snapshot maintained by `runLocalStatusPoll` on a ~5s cadence — much
 * faster than the 25s git/PR sweep so the progress tracker's self-QA / self-review checkboxes
 * invalidate quickly after the user makes a local edit. Map is keyed by folder path; entries
 * survive sweep refreshes (the full sweep writes the same field via `buildFolderInfo`, but the
 * fast poll updates it five times per sweep in between).
 */
const localStatusCache = new Map<string, boolean>();

/**
 * Poll cadence for the AI pane "is this terminal rendering right now?" check. The daemon's
 * status reply is already a cheap in-memory lookup plus one local Unix-socket round-trip, so a
 * 1s tick is well within budget. Matched to `aiBusyWindowMs` in pty-pool so a pane that goes
 * quiet for one tick reliably falls out of Busy on the next tick.
 */
const paneStatusPollMs = 1_000;

/**
 * Poll cadence for the per-worktree `git status --porcelain` check that feeds the progress
 * tracker's "uncommitted changes" input. Five seconds is a compromise: fast enough that
 * unchecking self-QA / self-review on first edit feels responsive, slow enough to avoid
 * spawning a git subprocess per worktree every second. The poll walks worktrees sequentially
 * to stay friendly under many-repo configs.
 */
const localStatusPollMs = 5_000;

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
        isBaseBranch: target.isBase,
        aiHidden: target.aiHidden,
        aiCmd: target.aiCmd,
        resetAiSessionCmd: target.resetAiSessionCmd,
        isHidden: target.isHidden,
        doLater: target.doLater,
        branch: null,
        git: {
            dirty: false,
            notPushed: false,
        },
        prUrl: null,
        prMerged: false,
        hasUncommittedChanges: false,
        localCommitHash: null,
        branchCommitHash: null,
        prIsDraft: false,
        prCiPassing: null,
        prCiInProgress: false,
        prReviewCheckPassing: null,
        prReviewCheckInProgress: false,
        prApproved: false,
        prReviewChangesRequested: false,
        prReviewPending: false,
        prHasUnresolvedReviewComments: false,
        prHasMergeConflicts: false,
        lastReviewedSha: target.lastReviewedSha,
        mergeStepValues: target.mergeStepValues,
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
 * new status into the cache. Target-derived fields (aiHidden, isBaseBranch, parentRepoPath,
 * isWorktreeRoot) are also overlaid from the live config so "Show/Hide AI pane" and other config
 * toggles don't lag the next ~25s sweep.
 */
export function getCachedFolders(): FolderInfo[] {
    return refreshState.targets.map((target) => {
        const cached = cache.get(target.folder);
        const base = cached ?? placeholderFolderInfo(target);
        // Target-derived fields (aiHidden, isBaseBranch, parentRepoPath, isWorktreeRoot) come
        // straight from the live config. Pane statuses come from the 1s ticker, not the slow
        // sweep — without this overlay the sidebar's Working / Needs-attention grouping would
        // lag actual Claude activity by up to one full sweep cycle (~25s).
        // Fast-poll override: `localStatusCache` updates every ~5s vs the ~25s sweep, so
        // self-QA / self-review can re-invalidate within a few seconds of the user touching a
        // file. Falls back to the cached `git.dirty` for the very first response before the
        // fast poll has run.
        const liveUncommitted =
            localStatusCache.get(target.folder) ?? base.hasUncommittedChanges;
        return {
            ...base,
            parentRepoPath: target.parentRepoPath,
            isWorktreeRoot: target.isWorktreeRoot,
            isBaseBranch: target.isBase,
            aiHidden: target.aiHidden,
            aiCmd: target.aiCmd,
            resetAiSessionCmd: target.resetAiSessionCmd,
            isHidden: target.isHidden,
            doLater: target.doLater,
            hasUncommittedChanges: liveUncommitted,
            // `lastReviewedSha` and `mergeStepValues` are authored at the config layer (the
            // `/worktrees/mark-reviewed` and `/worktrees/set-merge-step` endpoints write
            // there). Always emit the target's value so a fresh check surfaces on the very
            // next `/folders` poll instead of waiting for the next sweep.
            lastReviewedSha: target.lastReviewedSha,
            mergeStepValues: target.mergeStepValues,
            panes: {
                ai: livePaneStatus.lookup(target.folder, PaneKind.Ai),
                shell: livePaneStatus.lookup(target.folder, PaneKind.Shell),
            },
        };
    });
}

/**
 * Re-enumerate targets from the given config and publish them immediately so `/folders` reflects
 * the change without waiting for the next background sweep. Use this when the caller has already
 * mutated and saved `config.repos[].worktrees` directly (e.g. via `addWorktreeToConfig`) — it
 * skips the full disk-scan reconcile, which is the slow part on repos with many worktrees.
 */
export function publishTargets(config: Readonly<Config>): void {
    const targets = enumerateTargets(config);
    refreshState.targets = targets;
    const validPaths = new Set(targets.map((target) => target.folder));
    const stale = Array.from(cache.keys()).filter((path) => !validPaths.has(path));
    stale.forEach((path) => cache.delete(path));
    persistCache();
}

/**
 * Reconcile-then-publish: scans disk to rebuild every repo's worktree list, persists any drift
 * back to disk, and publishes the resulting targets. Use this when the caller can't precompute
 * the delta — i.e. the `/config` PUT endpoint, where an arbitrary config replaces the live one
 * and we don't know which worktrees changed. The sweep idles for up to ~10s between runs; without
 * this hook a repo added (or deleted) via an endpoint would not appear in (or disappear from)
 * `/folders` for that whole window, which makes the frontend's "home + empty folders → redirect
 * to /add-repo" guard fire spuriously right after add.
 *
 * Returns the reconciled config in case the caller wants to skip a redundant reload.
 */
export async function publishTargetsFromConfig(config: Readonly<Config>): Promise<Config> {
    const {config: reconciled, changed} = await reconcileConfig(config);
    if (changed) {
        await saveConfig(reconciled);
    }
    publishTargets(reconciled);
    return reconciled;
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

/**
 * The shape of `FolderInfo` evolves; cache files written by older builds can be missing fields
 * the current schema marks as required (e.g. `isBaseBranch` landed after the worktree-config
 * refactor). Drop any cached entry whose top-level fields don't line up so `/folders` doesn't
 * serve a response that fails its own outgoing-shape validation — the next sweep will repopulate.
 */
function isValidCachedFolderInfo(info: unknown): info is FolderInfo {
    if (!info || typeof info !== 'object') {
        return false;
    }
    const candidate = info as Partial<FolderInfo>;
    return (
        typeof candidate.path === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.isWorktreeRoot === 'boolean' &&
        typeof candidate.isBaseBranch === 'boolean' &&
        typeof candidate.aiHidden === 'boolean' &&
        !!candidate.git &&
        !!candidate.panes
    );
}

/**
 * Backfill any fields a pre-merge-step-tracker cache file is missing. The cache survives across
 * server upgrades, so an older entry could be lacking `hasUncommittedChanges`,
 * `localCommitHash`, `branchCommitHash`, `prIsDraft`, `prCiPassing`, `prCiInProgress`,
 * `prApproved`, `prReviewChangesRequested`, `prReviewPending`, or `lastReviewedSha`. Without
 * backfill, `/folders` would emit those as undefined and fail outgoing-shape validation on the
 * very first request after restart.
 */
function normalizeCachedFolderInfo(info: FolderInfo): FolderInfo {
    return {
        ...info,
        hasUncommittedChanges:
            typeof info.hasUncommittedChanges === 'boolean'
                ? info.hasUncommittedChanges
                : info.git.dirty,
        localCommitHash:
            typeof info.localCommitHash === 'string' || info.localCommitHash === null
                ? info.localCommitHash
                : null,
        branchCommitHash:
            typeof info.branchCommitHash === 'string' || info.branchCommitHash === null
                ? info.branchCommitHash
                : null,
        prIsDraft: typeof info.prIsDraft === 'boolean' ? info.prIsDraft : false,
        prCiPassing:
            typeof info.prCiPassing === 'boolean' || info.prCiPassing === null
                ? info.prCiPassing
                : null,
        prCiInProgress:
            typeof info.prCiInProgress === 'boolean' ? info.prCiInProgress : false,
        prReviewCheckPassing:
            typeof info.prReviewCheckPassing === 'boolean' || info.prReviewCheckPassing === null
                ? info.prReviewCheckPassing
                : null,
        prReviewCheckInProgress:
            typeof info.prReviewCheckInProgress === 'boolean'
                ? info.prReviewCheckInProgress
                : false,
        prApproved: typeof info.prApproved === 'boolean' ? info.prApproved : false,
        prReviewChangesRequested:
            typeof info.prReviewChangesRequested === 'boolean'
                ? info.prReviewChangesRequested
                : false,
        prReviewPending:
            typeof info.prReviewPending === 'boolean' ? info.prReviewPending : false,
        prHasUnresolvedReviewComments:
            typeof info.prHasUnresolvedReviewComments === 'boolean'
                ? info.prHasUnresolvedReviewComments
                : false,
        prHasMergeConflicts:
            typeof info.prHasMergeConflicts === 'boolean' ? info.prHasMergeConflicts : false,
        lastReviewedSha:
            typeof info.lastReviewedSha === 'string' || info.lastReviewedSha === null
                ? info.lastReviewedSha
                : null,
        mergeStepValues:
            info.mergeStepValues && typeof info.mergeStepValues === 'object'
                ? info.mergeStepValues
                : {},
        isHidden: typeof info.isHidden === 'boolean' ? info.isHidden : false,
        doLater: typeof info.doLater === 'boolean' ? info.doLater : false,
        aiCmd: typeof info.aiCmd === 'string' ? info.aiCmd : '',
        resetAiSessionCmd:
            typeof info.resetAiSessionCmd === 'string' ? info.resetAiSessionCmd : '',
    };
}

function isValidCachedTarget(target: unknown): target is RefreshTarget {
    if (!target || typeof target !== 'object') {
        return false;
    }
    const candidate = target as Partial<RefreshTarget>;
    return (
        typeof candidate.folder === 'string' &&
        typeof candidate.isWorktreeRoot === 'boolean' &&
        typeof candidate.isBase === 'boolean' &&
        typeof candidate.aiHidden === 'boolean'
    );
}

async function loadPersistedCache(): Promise<void> {
    const contents = await readFile(folderInfoCachePath, 'utf-8').catch(() => undefined);
    if (!contents) {
        return;
    }
    try {
        const parsed = JSON.parse(contents) as PersistedCache;
        if (Array.isArray(parsed.targets) && Array.isArray(parsed.entries)) {
            refreshState.targets = parsed.targets.filter(isValidCachedTarget).map((target) => ({
                ...target,
                aiCmd: typeof target.aiCmd === 'string' ? target.aiCmd : '',
                resetAiSessionCmd:
                    typeof target.resetAiSessionCmd === 'string' ? target.resetAiSessionCmd : '',
                lastReviewedSha:
                    typeof target.lastReviewedSha === 'string' || target.lastReviewedSha === null
                        ? target.lastReviewedSha
                        : null,
                mergeStepValues:
                    target.mergeStepValues && typeof target.mergeStepValues === 'object'
                        ? target.mergeStepValues
                        : {},
                isHidden: typeof target.isHidden === 'boolean' ? target.isHidden : false,
                doLater: typeof target.doLater === 'boolean' ? target.doLater : false,
            }));
            parsed.entries.forEach((pair) => {
                if (!Array.isArray(pair) || pair.length !== 2) {
                    return;
                }
                const [
                    path,
                    info,
                ] = pair;
                if (typeof path === 'string' && isValidCachedFolderInfo(info)) {
                    cache.set(path, normalizeCachedFolderInfo(info));
                }
            });
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
                /**
                 * Branches confirmed-checked during the cache window — populated from the batch
                 * keys at fetch time and grown by per-branch fallbacks. Optional in the persisted
                 * shape for backward compatibility with caches written before this field existed.
                 */
                checkedBranches?: ReadonlyArray<string>;
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
                    checkedBranches: Array.from(entry.checkedBranches),
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
                    if (typeof entry?.fetchedAt !== 'number' || !Array.isArray(entry.prs)) {
                        return;
                    }
                    /**
                     * Restore every persisted entry regardless of TTL. Entries older than
                     * `repoPrCacheTtlMs` are still useful as the "preserve prior" fallback
                     * when the new sweep can't reach GitHub (no active pane + cache stale,
                     * auth backoff, etc.) — they'll be refreshed naturally on the next
                     * eligible sweep, but until then we serve them rather than blanking the
                     * sidebar. The previous load logic dropped these entries, which is why a
                     * cold restart followed by a stretch of inactivity wiped PR badges.
                     */
                    const prsByBranch: Map<string, PrInfo> = new Map(entry.prs);
                    const rawChecked: unknown = entry.checkedBranches;
                    const checkedBranches = Array.isArray(rawChecked)
                        ? new Set(
                              rawChecked.filter(
                                  (value: unknown): value is string => typeof value === 'string',
                              ),
                          )
                        : new Set(prsByBranch.keys());
                    repoPrCache.set(key, {
                        fetchedAt: entry.fetchedAt,
                        prsByBranch,
                        checkedBranches,
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

/**
 * Auto-hide a worktree the moment we observe its PR transition from open to merged — the row
 * drops out of the sidebar's default view but the worktree, its files, and its panes are left
 * fully intact (recoverable via the "Show hidden" toggle). The transition must be witnessed by
 * *this server*: a prior FolderInfo with `prUrl` set and `prMerged: false`, followed by a fresh
 * `prMerged: true`. A first-observation merged PR (no prior, or `prUrl` was null) counts as
 * "previous status unknown" and is never enough — a freshly-started server shouldn't hide
 * worktrees whose PRs were merged before we ever saw them open. Skips the base-branch worktree,
 * already-hidden worktrees, and worktrees with a live Claude/shell pane (the user is still
 * working there).
 */
function shouldAutoHideOnMerge(
    target: Readonly<RefreshTarget>,
    prior: Readonly<FolderInfo> | undefined,
    info: Readonly<FolderInfo>,
): boolean {
    if (target.isWorktreeRoot || target.isBase || !target.parentRepoPath) {
        return false;
    }
    if (target.isHidden) {
        return false;
    }
    if (!prior || !prior.prUrl || prior.prMerged) {
        return false;
    }
    if (!info.prMerged || !info.prUrl) {
        return false;
    }
    if (isLivePaneStatus(info.panes.ai) || isLivePaneStatus(info.panes.shell)) {
        return false;
    }
    return true;
}

async function autoHideMergedWorktree(target: Readonly<RefreshTarget>): Promise<void> {
    log.info(`Auto-hiding merged worktree ${target.folder} (PR merged since last sweep).`);
    const config = await loadConfig();
    if (config.hiddenWorktrees.includes(target.folder)) {
        return;
    }
    const updatedConfig: Config = {
        ...config,
        hiddenWorktrees: [...config.hiddenWorktrees, target.folder],
    };
    await saveConfig(updatedConfig).catch(() => {
        /* persistence is best-effort — the row still hides this session via publishTargets */
    });
    publishTargets(updatedConfig);
}

async function refreshOnce(
    target: RefreshTarget,
    statusLookup: PaneStatusLookup,
    disabledGitHubPolling: boolean,
    repoHasActivePane: boolean,
): Promise<void> {
    try {
        const prior = cache.get(target.folder);
        const info = await buildFolderInfo({
            target,
            statusLookup,
            disabledGitHubPolling,
            repoHasActivePane,
            prior,
        });
        if (shouldAutoHideOnMerge(target, prior, info)) {
            await autoHideMergedWorktree(target);
        }
        cache.set(target.folder, info);
        /**
         * No persistCache() here on purpose: this runs once per folder per sweep, and each call
         * serializes the ENTIRE cache — per-folder persistence made sweeps O(N²) in JSON.stringify
         * work. The sweep persists once after the loop; a crash mid-sweep costs at most one
         * sweep's freshness in a best-effort cache.
         */
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
    const loaded = await loadConfig().catch(() => undefined);
    if (!loaded) {
        return;
    }
    // Reconcile drift (worktrees added/removed via the CLI outside agent-storm) before each
    // sweep. Persisting keeps the on-disk config — the source of truth for the sidebar — in
    // sync with reality.
    const {config: reconciled, changed} = await reconcileConfig(loaded);
    if (changed) {
        await saveConfig(reconciled).catch(() => {
            /* persistence is best-effort — the in-memory config is still authoritative this sweep */
        });
    }
    const config = reconciled;
    const targets = enumerateTargets(config);
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
     * `getOrFetchRepoCacheEntry` uses this to skip the GraphQL fetch for repos the user isn't actively
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
    // Single end-of-sweep persist covers every refreshOnce write above plus the stale prune.
    persistCache();
}

async function refreshLivePaneStatus(): Promise<void> {
    try {
        livePaneStatus.lookup = await getPaneStatusLookup();
    } catch {
        /* swallow — keep the previous snapshot until the next tick succeeds */
    }
}

/**
 * Sweep currently-published targets with the cheap `git status --porcelain` probe and publish the
 * result into `localStatusCache`. Sequential to keep subprocess pressure flat; stale entries
 * (folders dropped from the published target list) are pruned at the end. Only considers
 * non-worktree-root targets — the bare worktree root has no working tree of its own.
 *
 * Only folders with a live AI/Shell pane are probed: the fast poll exists so the progress
 * tracker's self-QA / self-review checkboxes invalidate quickly while the user (or Claude) is
 * actively editing, and active editing implies a live pane. Idle folders fall back to the ~25s
 * sweep's `git.dirty` — their cache entry is dropped so a stale fast-poll value can't shadow the
 * fresher sweep result in `getCachedFolders`. This keeps the always-on subprocess rate
 * proportional to active folders instead of total worktrees.
 */
async function refreshLocalStatus(): Promise<void> {
    const targets = refreshState.targets;
    for (const target of targets) {
        if (target.isWorktreeRoot) {
            continue;
        }
        const hasLivePane =
            isLivePaneStatus(livePaneStatus.lookup(target.folder, PaneKind.Ai)) ||
            isLivePaneStatus(livePaneStatus.lookup(target.folder, PaneKind.Shell));
        if (!hasLivePane) {
            localStatusCache.delete(target.folder);
            continue;
        }
        try {
            const dirty = await hasUncommittedChanges(target.folder);
            localStatusCache.set(target.folder, dirty);
        } catch {
            /* swallow — keep the last-known value rather than flipping to clean on a blip */
        }
    }
    const validPaths = new Set(targets.map((target) => target.folder));
    for (const path of Array.from(localStatusCache.keys())) {
        if (!validPaths.has(path)) {
            localStatusCache.delete(path);
        }
    }
}

function scheduleLocalStatusPoll(): void {
    setTimeout(() => {
        refreshLocalStatus().finally(scheduleLocalStatusPoll);
    }, localStatusPollMs);
}

/**
 * Recursive `setTimeout` rather than `setInterval` so a slow daemon round-trip can never cause
 * two pane-status fetches to overlap. The poll runs continuously from server startup so the
 * sidebar reflects live Claude activity even when no full sweep has run recently.
 */
function schedulePaneStatusPoll(): void {
    setTimeout(() => {
        refreshLivePaneStatus().finally(schedulePaneStatusPoll);
    }, paneStatusPollMs);
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
    refreshState.targets = enumerateTargets(config);
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
    // Prime the live pane-status snapshot before starting the slow sweep so the first
    // `/folders` request already sees real pane states rather than the PaneStatus.None default.
    await refreshLivePaneStatus();
    schedulePaneStatusPoll();
    scheduleLocalStatusPoll();
    runSweep()
        .catch(() => {
            /* never let the loop die; just move on to the next sweep */
        })
        .finally(scheduleNextSweep);
}
