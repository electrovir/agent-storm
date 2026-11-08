import {
    type AiDefinition,
    type FolderInfo,
    type RepoConfig,
    type SidebarGrouping,
    type SidebarSorting,
    type UpdateStatus,
} from '@agent-storm/common';
import {type FolderData} from '../../util/folder-data.js';
import {type VirSidebarChangeAiModal} from './vir-sidebar-change-ai-modal.element.js';

/**
 * Value of the "use the default AI" entry in the add-repo / add-worktree selects. Mapped back to
 * "no override" at submit time.
 */
export const defaultAiSelectValue = 'default';

export type SidebarState = {
    folders: ReadonlyArray<FolderInfo>;
    removeFolderDataListener: (() => void) | undefined;
    loadError: string | undefined;
    openMenuKey: string | undefined;
    isAddRepoModalOpen: boolean;
    /** The repo the "Add worktree" modal creates under. `undefined` while that modal is closed. */
    addWorktreeRepoPath: string | undefined;
    changeAiTarget: (typeof VirSidebarChangeAiModal)['InputsType']['target'];
    /**
     * Mirrors `config.aiDefinitions` so the picker and the add-repo / add-worktree modals can list
     * the user's AIs. Kept in lockstep with the folders list via `refresh()`.
     */
    aiDefinitions: ReadonlyArray<AiDefinition>;
    /** Mirrors `config.defaultAiId`, used to name what an un-overridden folder inherits. */
    defaultAiId: string;
    /**
     * Mirrors `config.sidebarGrouping`. Fetched lazily on first refresh tick so the filter menu can
     * show which grouping is currently active (and so flipping it via the menu has a fresh value to
     * write back into config). `undefined` while we haven't loaded config yet.
     */
    sidebarGrouping: SidebarGrouping | undefined;
    /**
     * Mirrors `config.sidebarSorting`. Picks the comparator used for the standalone list, the
     * worktree roots, and each root's children. `undefined` while config hasn't loaded, which sorts
     * the same as {@link SidebarSorting.Name}.
     */
    sidebarSorting: SidebarSorting | undefined;
    /**
     * Mirrors `config.onlyShowRecent`. When true the sidebar hides standalone repos that lack
     * recent activity AND have no running panes; worktree-roots and their children are always
     * shown. `undefined` while config hasn't loaded yet, which renders the same as `false`.
     */
    onlyShowRecent: boolean | undefined;
    /**
     * Live text from the header search pop-up. While non-empty it temporarily overrides the
     * hide-inactive filter and shows only repos/worktrees whose names match (searching active and
     * inactive repos alike). Persists after the pop-up closes — clearing the input (or its clear
     * button) is what ends the search.
     */
    searchQuery: string;
    /**
     * Mirrors `config.repos`. Needed for the hide-inactive filter so we can look up each repo's
     * `lastInteractedAtMs` against the 7-day cutoff. Kept in lockstep with the folders list via
     * `refresh()`.
     */
    repos: ReadonlyArray<RepoConfig>;
    /**
     * Result of the backend's "agent-storm checkout vs upstream `dev`" probe. The banner at the
     * bottom of the sidebar appears only when `isUpToDate === false`; every other value (including
     * the `null`s the backend returns when it can't determine status, or when the user has disabled
     * the check) keeps the banner hidden. `undefined` while the first poll is still in flight.
     */
    updateStatus: UpdateStatus | undefined;
};

export type SidebarUpdate = (newState: Partial<SidebarState>) => void;

export function folderDataState({
    snapshot,
    live,
    loadError,
}: Readonly<FolderData>): Partial<SidebarState> {
    return {
        ...(snapshot
            ? {
                  folders: pendingWorktreeDeletions.size
                      ? snapshot.folders.filter(
                            (folder) => !pendingWorktreeDeletions.has(folder.path),
                        )
                      : snapshot.folders,
                  sidebarGrouping: snapshot.config.sidebarGrouping,
                  sidebarSorting: snapshot.config.sidebarSorting,
                  onlyShowRecent: snapshot.config.onlyShowRecent,
                  repos: snapshot.config.repos,
                  aiDefinitions: snapshot.config.aiDefinitions,
                  defaultAiId: snapshot.config.defaultAiId,
              }
            : {}),
        loadError,
        updateStatus: live?.updateStatus,
    };
}

/**
 * Worktrees the user has asked to delete that the backend is still processing. The 2s sidebar poll
 * fetches `/folders` while `git worktree remove --force` + `refreshFolderInfoNow` are still in
 * flight, so without this filter the deleted row would pop back in until the backend's response
 * lands. Entries clear in `confirmDeleteWorktree`'s `finally` once the delete settles (success or
 * failure).
 */
export const pendingWorktreeDeletions = new Set<string>();
