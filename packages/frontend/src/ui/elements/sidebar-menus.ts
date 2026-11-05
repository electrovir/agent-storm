import {
    type FolderInfo,
    SidebarGrouping,
    SidebarSorting,
    WatchModeStatus,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {log} from '@augment-vir/common';
import {html} from 'element-vir';
import {parseUrl} from 'url-vir';
import {
    LucideCheckIcon,
    LucideEyeIcon,
    LucideEyeOffIcon,
    LucideRotateCwIcon,
    LucideTrashIcon,
    LucideXIcon,
    ViraLink,
    type ViraMenuItemEntry,
} from 'vira';

/** Everything a folder row's or a repo header's menu can ask the sidebar to do. */
export enum SidebarFolderAction {
    ToggleWatch = 'toggle-watch',
    AddWorktree = 'add-worktree',
    ChangeAi = 'change-ai',
    OpenSettings = 'open-settings',
    RestartPanes = 'restart-panes',
    KillPanes = 'kill-panes',
    HideRepo = 'hide-repo',
    DeleteWorktree = 'delete-worktree',
    RemoveRepo = 'remove-repo',
}

const allowedLinkHostnames = ['github.com'];

const sidebarGroupingLabels: Record<SidebarGrouping, string> = {
    [SidebarGrouping.Repo]: 'Group by repo',
    [SidebarGrouping.Status]: 'Group by status',
};

const sidebarSortingLabels: Record<SidebarSorting, string> = {
    [SidebarSorting.Name]: 'Sort by name',
    [SidebarSorting.Date]: 'Sort by created',
    [SidebarSorting.Activity]: 'Sort by activity',
};

function isValidPrUrl(url: string | null | undefined): boolean {
    if (!url) {
        return false;
    }

    const parsed = parseUrl(url);
    const isHttp = parsed.protocol === 'https' || parsed.protocol === 'http';

    if (!isHttp) {
        log.error(`Cannot open non http URL: '${url}'`);
        return false;
    } else if (allowedLinkHostnames.includes(parsed.hostname)) {
        return true;
    } else {
        log.error(`Cannot open non approved host name: '${url}'`);
        return false;
    }
}

/**
 * Grouped rather than flat so the render can draw a divider between each section: grouping, then
 * sorting, then the standalone filters.
 */
export function buildFilterMenuSections({
    sidebarGrouping,
    sidebarSorting,
    onlyShowRecent,
    onGroupingSelect,
    onSortingSelect,
    onHideInactiveChange,
}: Readonly<{
    sidebarGrouping: SidebarGrouping | undefined;
    sidebarSorting: SidebarSorting | undefined;
    onlyShowRecent: boolean | undefined;
    onGroupingSelect: (grouping: SidebarGrouping) => void;
    onSortingSelect: (sorting: SidebarSorting) => void;
    onHideInactiveChange: (onlyShowRecent: boolean) => void;
}>): ReadonlyArray<ReadonlyArray<ViraMenuItemEntry>> {
    const groupingEntries: ReadonlyArray<ViraMenuItemEntry> = [
        SidebarGrouping.Repo,
        SidebarGrouping.Status,
    ].map((grouping) => {
        return {
            content: sidebarGroupingLabels[grouping],
            /**
             * Mark the active grouping with a check; non-active entries get no icon. `iconOverride`
             * is the menu's per-item icon slot — leaving it undefined leaves blank space, which
             * keeps the labels visually aligned across rows.
             */
            iconOverride: sidebarGrouping === grouping ? LucideCheckIcon : undefined,
            onClick() {
                if (sidebarGrouping === grouping) {
                    return;
                }
                onGroupingSelect(grouping);
            },
        };
    });
    /**
     * The sort options are mutually exclusive: picking one writes the single
     * `config.sidebarSorting` value, which drops the check from the others.
     */
    const sortingEntries: ReadonlyArray<ViraMenuItemEntry> = [
        SidebarSorting.Name,
        SidebarSorting.Date,
        SidebarSorting.Activity,
    ].map((sorting) => {
        return {
            content: sidebarSortingLabels[sorting],
            iconOverride:
                (sidebarSorting ?? SidebarSorting.Name) === sorting ? LucideCheckIcon : undefined,
            onClick() {
                if ((sidebarSorting ?? SidebarSorting.Name) === sorting) {
                    return;
                }
                onSortingSelect(sorting);
            },
        };
    });
    return [
        groupingEntries,
        sortingEntries,
        [
            {
                content: 'Hide Inactive',
                /**
                 * Click toggles the persisted `onlyShowRecent` flag. A check icon shows the current
                 * state — the user can flip it off the same way they turned it on.
                 */
                iconOverride: onlyShowRecent ? LucideCheckIcon : undefined,
                onClick() {
                    onHideInactiveChange(!onlyShowRecent);
                },
            },
        ],
    ];
}

export function buildRowMenuEntries({
    folder,
    onSelect,
}: Readonly<{
    folder: FolderInfo;
    onSelect: (action: SidebarFolderAction) => void;
}>): ReadonlyArray<ViraMenuItemEntry> {
    return [
        folder.prUrl &&
            isValidPrUrl(folder.prUrl) && {
                content: html`
                    <${ViraLink.assign({
                        link: {
                            url: folder.prUrl,
                            newTab: true,
                        },
                        disableLinkStyles: true,
                    })}>
                        Open PR
                    </${ViraLink}>
                `,
            },
        !!folder.branch && {
            content:
                folder.watchMode.status === WatchModeStatus.Off ? 'Watch PR' : 'Stop watching PR',
            iconOverride:
                folder.watchMode.status === WatchModeStatus.Off ? LucideEyeIcon : LucideEyeOffIcon,
            onClick() {
                onSelect(SidebarFolderAction.ToggleWatch);
            },
        },
        {
            content: 'Change AI',
            onClick() {
                onSelect(SidebarFolderAction.ChangeAi);
            },
        },
        !folder.parentRepoPath && {
            content: 'Settings',
            onClick() {
                onSelect(SidebarFolderAction.OpenSettings);
            },
        },
        {
            content: 'Restart panes',
            iconOverride: LucideRotateCwIcon,
            onClick() {
                onSelect(SidebarFolderAction.RestartPanes);
            },
        },
        {
            content: 'Kill panes',
            onClick() {
                onSelect(SidebarFolderAction.KillPanes);
            },
        },
        /** Standalone repos only (worktree children carry a `parentRepoPath`). */
        !folder.parentRepoPath && {
            content: 'Hide repo',
            onClick() {
                onSelect(SidebarFolderAction.HideRepo);
            },
        },
        folder.parentRepoPath
            ? {
                  content: html`
                      <span class="danger-menu-item">Delete worktree</span>
                  `,
                  iconOverride: LucideTrashIcon,
                  onClick() {
                      onSelect(SidebarFolderAction.DeleteWorktree);
                  },
              }
            : {
                  content: html`
                      <span class="danger-menu-item">Remove repo</span>
                  `,
                  iconOverride: LucideXIcon,
                  onClick() {
                      onSelect(SidebarFolderAction.RemoveRepo);
                  },
              },
    ].filter(check.isTruthy);
}

/** The menu on a worktree root's header, which acts on the repo as a whole. */
export function buildRepoMenuEntries(
    onSelect: (action: SidebarFolderAction) => void,
): ReadonlyArray<ViraMenuItemEntry> {
    return [
        {
            content: 'Add worktree',
            onClick() {
                onSelect(SidebarFolderAction.AddWorktree);
            },
        },
        {
            /**
             * The root's AI is what every child worktree inherits (unless the child sets its own),
             * so this is the one place to change the AI for a whole repo's worktrees at once.
             */
            content: 'Change AI',
            onClick() {
                onSelect(SidebarFolderAction.ChangeAi);
            },
        },
        {
            content: 'Settings',
            onClick() {
                onSelect(SidebarFolderAction.OpenSettings);
            },
        },
        {
            content: html`
                <span class="danger-menu-item">Remove repo</span>
            `,
            iconOverride: LucideXIcon,
            onClick() {
                onSelect(SidebarFolderAction.RemoveRepo);
            },
        },
    ];
}
