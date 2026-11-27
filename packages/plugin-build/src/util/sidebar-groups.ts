import {type FolderInfo, type SavedRepo, SidebarSorting} from '@agent-storm/common';
import {getPrRingRank} from '@agent-storm/core/frontend';
import {calculateRelativeDate, createUtcFullDate, getNowInUtcTimezone, isDateAfter} from 'date-vir';
import {type Thread} from '../build-api.js';
import {type ThreadRepoGroup} from './thread-timeline.js';

/**
 * Each sorting's key for the threads within a folder, largest first. Ties keep their order, and
 * `undefined` keeps every thread's order.
 */
const threadSortKeys: Record<
    SidebarSorting,
    | ((
          params: Readonly<{
              thread: Readonly<Thread>;
              folderInfo: ReadonlyMap<string, Readonly<FolderInfo>>;
          }>,
      ) => number)
    | undefined
> = {
    [SidebarSorting.Name]: undefined,
    [SidebarSorting.Date]: undefined,
    [SidebarSorting.Activity]: undefined,
    /** The ring a thread row shows is its working folder's. */
    [SidebarSorting.Status]({thread, folderInfo}) {
        const folder = folderInfo.get(thread.cwd);
        return folder ? getPrRingRank(folder) : -1;
    },
};

/** Each sorting's key, largest first. Ties, and every group under name sorting, go by name. */
const groupSortKeys: Record<
    SidebarSorting,
    (
        params: Readonly<{
            group: ThreadRepoGroup;
            folder: Readonly<FolderInfo> | undefined;
            archivedThreadIds: ReadonlySet<Thread['id']>;
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
     * Activity reorders the threads within each folder, not the folders themselves: folders with a
     * thread that isn't archived go first, and the rest go last.
     */
    [SidebarSorting.Activity]({group, archivedThreadIds}) {
        return group.threads.some((thread) => !archivedThreadIds.has(thread.id)) ? 1 : 0;
    },
    /** Same folder order as activity; the status rings reorder the threads within each folder. */
    [SidebarSorting.Status](params) {
        return groupSortKeys[SidebarSorting.Activity](params);
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
 * The "Hide Inactive" rule: a folder shows while its saved repo was used recently. Hiding a folder
 * clears that timestamp, and using it again sets it.
 */
function filterByRecency(
    groups: ReadonlyArray<ThreadRepoGroup>,
    repos: ReadonlyArray<Readonly<SavedRepo>>,
) {
    const cutoff = calculateRelativeDate(getNowInUtcTimezone(), {
        days: -7,
    });
    return groups.filter((group) => {
        /** Any thread means the folder is in use, archived ones included while they're shown. */
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
    archivedThreadIds,
    repos,
    sorting,
    onlyShowRecent,
    searchQuery,
}: Readonly<{
    groups: ReadonlyArray<ThreadRepoGroup>;
    folderInfo: ReadonlyMap<string, Readonly<FolderInfo>>;
    archivedThreadIds: ReadonlySet<Thread['id']>;
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
    const selectedSorting = sorting ?? SidebarSorting.Name;
    const threadSortKey = threadSortKeys[selectedSorting];
    return shownGroups
        .map((group) => {
            return {
                group: threadSortKey
                    ? {
                          ...group,
                          threads: group.threads.toSorted((first, second) => {
                              return (
                                  threadSortKey({
                                      thread: second,
                                      folderInfo,
                                  }) -
                                  threadSortKey({
                                      thread: first,
                                      folderInfo,
                                  })
                              );
                          }),
                      }
                    : group,
                sortKey: groupSortKeys[selectedSorting]({
                    group,
                    folder: folderInfo.get(group.repo.path),
                    archivedThreadIds,
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
