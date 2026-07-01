import type {Config, RepoConfig} from '@agent-storm/common';
import {getGitInfo, isWorktreeRoot, listWorktreeChildren} from './git.js';

/**
 * Walks every repo in the config and rebuilds its `worktrees` + `isWorktreeLayout` from the
 * current filesystem state. This is the only place we scan disk for worktrees — every other
 * consumer (`enumerateTargets`, the sidebar) reads from `repo.worktrees` so the placeholder
 * `FolderInfo` (returned before the background sweep has fetched git info) already knows which
 * worktree is the base branch and can hide it.
 *
 * Reconcile reads git for each on-disk worktree once per call so `isBase` reflects the current
 * branch checked out at that path versus the repo's configured `baseBranch`. The result is a new
 * Config plus a `changed` flag; callers should persist the new config when `changed` is true.
 */
export async function reconcileConfig(
    config: Readonly<Config>,
): Promise<{config: Config; changed: boolean}> {
    let changed = false;
    const newRepos = await Promise.all(
        config.repos.map(async (repo) => {
            const next = await reconcileRepo(repo);
            if (!repoEquals(repo, next)) {
                changed = true;
            }
            return next;
        }),
    );
    return {
        config: changed ? {...config, repos: newRepos} : config,
        changed,
    };
}

async function reconcileRepo(repo: Readonly<RepoConfig>): Promise<RepoConfig> {
    const isLayout = await isWorktreeRoot(repo.path);
    if (!isLayout) {
        return {
            ...repo,
            worktrees: [],
            isWorktreeLayout: false,
        };
    }
    const onDisk = await listWorktreeChildren(repo.path);
    // Preserve `lastReviewedSha` + `mergeStepValues` across reconcile — both are the progress
    // tracker's source of truth and would otherwise reset every time a sweep runs.
    const existingByPath = new Map(repo.worktrees.map((worktree) => [worktree.path, worktree]));
    const worktrees = await Promise.all(
        onDisk.map(async (path) => {
            const info = await getGitInfo(path);
            const isBase = !!repo.baseBranch && info.branch === repo.baseBranch;
            const existing = existingByPath.get(path);
            return {
                path,
                isBase,
                lastReviewedSha: existing?.lastReviewedSha ?? null,
                mergeStepValues: existing?.mergeStepValues ?? {},
            };
        }),
    );
    return {
        ...repo,
        worktrees,
        isWorktreeLayout: true,
    };
}

/**
 * Fast path for the "we just created a worktree" case. Appends `{path, isBase: false}` to the
 * matching repo's `worktrees` without touching disk — saves us a full reconcile (one git info
 * read per existing worktree) on every create. The periodic sweep still catches drift if the
 * user creates worktrees outside agent-storm. Returns the input untouched if the repo isn't in
 * config or the path is already tracked.
 */
export function addWorktreeToConfig(
    config: Readonly<Config>,
    repoPath: string,
    worktreePath: string,
): Config {
    const repos = config.repos.map((repo) => {
        if (repo.path !== repoPath) {
            return repo;
        } else if (repo.worktrees.some((worktree) => worktree.path === worktreePath)) {
            return repo;
        }
        return {
            ...repo,
            worktrees: [
                ...repo.worktrees,
                {
                    path: worktreePath,
                    isBase: false,
                    lastReviewedSha: null,
                    mergeStepValues: {},
                },
            ],
            isWorktreeLayout: true,
        };
    });
    return {...config, repos};
}

/**
 * Fast path for the "we just deleted a worktree" case. Drops the matching entry from
 * `worktrees` without re-scanning disk. Returns the input untouched if no entry matches.
 */
export function removeWorktreeFromConfig(
    config: Readonly<Config>,
    worktreePath: string,
): Config {
    const repos = config.repos.map((repo) => {
        if (!repo.worktrees.some((worktree) => worktree.path === worktreePath)) {
            return repo;
        }
        return {
            ...repo,
            worktrees: repo.worktrees.filter((worktree) => worktree.path !== worktreePath),
        };
    });
    return {...config, repos};
}

function repoEquals(a: Readonly<RepoConfig>, b: Readonly<RepoConfig>): boolean {
    if (a.isWorktreeLayout !== b.isWorktreeLayout) {
        return false;
    } else if (a.worktrees.length !== b.worktrees.length) {
        return false;
    }
    const byPath = new Map(b.worktrees.map((worktree) => [worktree.path, worktree]));
    return a.worktrees.every((worktree) => {
        const other = byPath.get(worktree.path);
        return (
            !!other &&
            other.isBase === worktree.isBase &&
            other.lastReviewedSha === worktree.lastReviewedSha &&
            mergeStepValuesEqual(other.mergeStepValues, worktree.mergeStepValues)
        );
    });
}

function mergeStepValuesEqual(
    a: Readonly<Partial<Record<string, boolean>>>,
    b: Readonly<Partial<Record<string, boolean>>>,
): boolean {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
        return false;
    }
    return aKeys.every((key) => a[key] === b[key]);
}
