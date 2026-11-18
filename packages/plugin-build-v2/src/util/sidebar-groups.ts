import {type FolderInfo, type SavedRepo, SidebarSorting} from '@agent-storm/common';
import {calculateRelativeDate, createUtcFullDate, getNowInUtcTimezone, isDateAfter} from 'date-vir';
import {type ThreadRepoGroup} from './thread-timeline.js';

/** Each sorting's key, largest first. Ties, and every group under name sorting, go by name. */
const groupSortKeys: Record<
    SidebarSorting,
    (
        params: Readonly<{
            group: ThreadRepoGroup;
            folder: Readonly<FolderInfo> | undefined;
            repoActivityAtMs: ReadonlyMap<string, number>;
        }>,
    ) => number
> = {
    [SidebarSorting.Name]() {
        return 0;
    },
    [SidebarSorting.Date]({folder}) {
        return folder?.createdAtMs || 0;
    },
    /**
     * A thread's latest message counts as activity, the same as typing in the folder's terminal.
     * Archived threads still count, so archiving one doesn't move its folder.
     */
    [SidebarSorting.Activity]({group, folder, repoActivityAtMs}) {
        return Math.max(
            repoActivityAtMs.get(group.repo.path) || 0,
            group.threads[0]?.updatedAt || 0,
            folder?.lastActivityAtMs || 0,
        );
    },
};

function filterBySearch(groups: ReadonlyArray<ThreadRepoGroup>, query: string) {
    const needle = query.toLowerCase();
    return groups.flatMap((group) => {
        if (group.repo.name.toLowerCase().includes(needle)) {
            return [
                group,
            ];
        }
        const threads = group.threads.filter((thread) => {
            return thread.title.toLowerCase().includes(needle);
        });
        return threads.length
            ? [
                  {
                      ...group,
                      threads,
                  },
              ]
            : [];
    });
}

/**
 * Same "Hide Inactive" rule as the Build tab's: a folder shows while its saved repo was used in the
 * last week. Hiding a folder clears that timestamp, and using it again in either sidebar sets it.
 */
function filterByRecency(
    groups: ReadonlyArray<ThreadRepoGroup>,
    repos: ReadonlyArray<Readonly<SavedRepo>>,
) {
    const cutoff = calculateRelativeDate(getNowInUtcTimezone(), {
        days: -7,
    });
    return groups.filter((group) => {
        /** The sidebar never holds archived threads, so any thread means the folder is in use. */
        if (group.threads.length) {
            return true;
        }
        const lastInteractedAtMs = repos.find(
            (repo) => repo.path === group.repo.path,
        )?.lastInteractedAtMs;
        return (
            lastInteractedAtMs != undefined &&
            isDateAfter({
                fullDate: createUtcFullDate(lastInteractedAtMs),
                relativeTo: cutoff,
            })
        );
    });
}

/**
 * The sidebar's groups after the header's search or "Hide Inactive" filter, in the selected order.
 * A search spans inactive folders too, and keeps every thread of a folder whose name matches.
 */
export function arrangeRepoGroups({
    groups,
    folderInfo,
    repoActivityAtMs,
    repos,
    sorting,
    onlyShowRecent,
    searchQuery,
}: Readonly<{
    groups: ReadonlyArray<ThreadRepoGroup>;
    folderInfo: ReadonlyMap<string, Readonly<FolderInfo>>;
    /** Repo path → its latest thread activity, archived threads included. */
    repoActivityAtMs: ReadonlyMap<string, number>;
    repos: ReadonlyArray<Readonly<SavedRepo>>;
    sorting: SidebarSorting | undefined;
    onlyShowRecent: boolean | undefined;
    searchQuery: string;
}>) {
    const trimmedQuery = searchQuery.trim();
    const shownGroups = trimmedQuery
        ? filterBySearch(groups, trimmedQuery)
        : onlyShowRecent
          ? filterByRecency(groups, repos)
          : groups;
    return shownGroups
        .map((group) => {
            return {
                group,
                sortKey: groupSortKeys[sorting ?? SidebarSorting.Name]({
                    group,
                    folder: folderInfo.get(group.repo.path),
                    repoActivityAtMs,
                }),
            };
        })
        .toSorted((first, second) => {
            return (
                second.sortKey - first.sortKey ||
                first.group.repo.name.localeCompare(second.group.repo.name, undefined, {
                    sensitivity: 'base',
                })
            );
        })
        .map(({group}) => group);
}
