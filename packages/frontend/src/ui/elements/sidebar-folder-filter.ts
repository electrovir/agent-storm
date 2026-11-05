import {type FolderInfo, PaneStatus, type RepoConfig, SidebarSorting} from '@agent-storm/common';
import {filterMap} from '@augment-vir/common';
import {
    type AnyDuration,
    calculateRelativeDate,
    createUtcFullDate,
    getNowInUtcTimezone,
    isDateAfter,
} from 'date-vir';

/**
 * Applies to the standalone list and to the worktrees within each repo. Repo headers themselves
 * stay alphabetical under every sorting — a header is a place to look things up, so it should sit
 * where the user last saw it rather than shuffle as its worktrees are worked in.
 */
export const folderComparators: Record<SidebarSorting, (a: FolderInfo, b: FolderInfo) => number> = {
    [SidebarSorting.Name](a, b) {
        return a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
        });
    },
    /**
     * Newest-created first. Folders the backend couldn't stat carry `createdAtMs: 0` and land at
     * the end, where they fall back to the name comparator.
     */
    [SidebarSorting.Date](a, b) {
        return b.createdAtMs - a.createdAtMs || folderComparators[SidebarSorting.Name](a, b);
    },
    /**
     * Most-recently-typed-in first. Repos nobody has typed in use their last-opened time instead.
     * Folders with neither carry `0` and land at the end, where they fall back to the name
     * comparator.
     */
    [SidebarSorting.Activity](a, b) {
        return (
            b.lastActivityAtMs - a.lastActivityAtMs || folderComparators[SidebarSorting.Name](a, b)
        );
    },
};

/**
 * Window for "recent" activity used by the hide-inactive filter. Anything older than this (or
 * missing a timestamp entirely) counts as inactive when `onlyShowRecent` is on. Standalone repos
 * with no recent timestamp can still appear if they have a running AI/shell pane.
 */
const recencyWindow: AnyDuration = {
    days: -7,
};

function isPaneRunning(status: PaneStatus): boolean {
    return (
        status === PaneStatus.Busy || status === PaneStatus.Stalled || status === PaneStatus.Idle
    );
}

/**
 * Filters folders according to the "Hide Inactive" rule:
 *
 * - Worktree-roots and their children are always shown (per the user's request — worktrees aren't
 *   gated by recency).
 * - Standalone repos are shown only if their `lastInteractedAtMs` is within the last 7 days OR they
 *   currently have a running pane (Busy/Idle on AI or shell), so an actively-running but
 *   never-touched repo still appears.
 */
export function filterByRecency(
    folders: ReadonlyArray<FolderInfo>,
    repos: ReadonlyArray<RepoConfig>,
): FolderInfo[] {
    const cutoff = calculateRelativeDate(getNowInUtcTimezone(), recencyWindow);
    const recentRepoPaths = new Set(
        repos
            .filter((repo) => {
                return (
                    repo.lastInteractedAtMs != undefined &&
                    isDateAfter({
                        fullDate: createUtcFullDate(repo.lastInteractedAtMs),
                        relativeTo: cutoff,
                    })
                );
            })
            .map((repo) => repo.path),
    );
    return folders.filter((folder) => {
        return (
            folder.isWorktreeRoot ||
            !!folder.parentRepoPath ||
            recentRepoPaths.has(folder.path) ||
            isPaneRunning(folder.panes.ai) ||
            isPaneRunning(folder.panes.shell)
        );
    });
}

/**
 * Filters folders by the header search query (case-insensitive substring on folder names),
 * searching active and inactive repos alike (recency is ignored while searching):
 *
 * - A standalone repo shows when its own name matches.
 * - A worktree child shows when its own name matches OR its parent worktree-root's name matches (so
 *   matching a repo surfaces all of its worktrees to pick from).
 * - A worktree-root shows when its own name matches OR at least one of its children matches.
 *   Therefore a worktree-root with no matching child and a non-matching name is hidden entirely.
 */
export function filterBySearch(folders: ReadonlyArray<FolderInfo>, query: string): FolderInfo[] {
    const needle = query.trim().toLowerCase();
    function nameMatches(folder: FolderInfo): boolean {
        return folder.name.toLowerCase().includes(needle);
    }
    const matchingRootPaths = new Set(
        folders
            .filter((folder) => folder.isWorktreeRoot && nameMatches(folder))
            .map((folder) => folder.path),
    );
    const rootPathsWithMatchingChild = new Set(
        filterMap(
            folders,
            (folder) => folder.parentRepoPath,
            (parentRepoPath, folder): parentRepoPath is string => {
                return !!parentRepoPath && nameMatches(folder);
            },
        ),
    );
    return folders.filter((folder) => {
        if (folder.isWorktreeRoot) {
            return (
                matchingRootPaths.has(folder.path) || rootPathsWithMatchingChild.has(folder.path)
            );
        } else if (folder.parentRepoPath) {
            return nameMatches(folder) || matchingRootPaths.has(folder.parentRepoPath);
        } else {
            return nameMatches(folder);
        }
    });
}
