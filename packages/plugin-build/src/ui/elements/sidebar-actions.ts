import {
    type AiDefinition,
    deleteWorktreeEndpoint,
    type FolderInfo,
    hideRepoEndpoint,
    installUpdateEndpoint,
    killPanesEndpoint,
    removeRepoEndpoint,
    type SavedRepo,
    settingsEndpoint,
    type SidebarGrouping,
    type SidebarSorting,
    updateCheckEndpoint,
    watchModeEndpoint,
    WatchModeStatus,
} from '@agent-storm/common';
import {
    fetchApi,
    type PaneRestartedEvent,
    restartFolderPanes,
    SettingsSection,
    type SettingsTarget,
} from '@agent-storm/core/frontend';
import {waitUntil} from '@augment-vir/assert';
import {extractErrorMessage, type MaybePromise, omitObjectKeys} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {type ViraDropdownOption} from 'vira';

import {cancelRepoHide, startRepoHide} from './sidebar-folder-filter.js';
import {SidebarFolderAction} from './sidebar-menus.js';
import {
    defaultAiSelectValue,
    pendingWorktreeDeletions,
    type SidebarUpdate,
} from './sidebar-state.js';

/**
 * Installs `version` and reloads the page into it once it's running. A version that fails also
 * reloads, which shows its failure in the banner.
 */
export async function installUpdate({
    version,
    updateState,
}: Readonly<{
    version: string;
    updateState: SidebarUpdate;
}>) {
    updateState({
        isUpdating: true,
    });
    try {
        await fetchApi(installUpdateEndpoint, HttpMethod.Post);
        await waitUntil.isTrue(
            async () => {
                /** The server is briefly unreachable while the launcher switches versions. */
                const status = await fetchApi(updateCheckEndpoint, HttpMethod.Get).catch(
                    () => undefined,
                );
                return status?.currentVersion === version || status?.failedVersion === version;
            },
            {
                interval: {
                    seconds: 2,
                },
                timeout: {
                    minutes: 15,
                },
            },
        );
        globalThis.location.reload();
    } catch (error: unknown) {
        updateState({
            isUpdating: false,
        });
        showError(updateState, error);
    }
}

export async function setSidebarGrouping(
    grouping: SidebarGrouping,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        await fetchApi(settingsEndpoint, HttpMethod.Put, {
            requestData: {
                ...settings,
                sidebarGrouping: grouping,
            },
        });
        updateState({
            sidebarGrouping: grouping,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

export async function setSidebarSorting(
    sorting: SidebarSorting,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        await fetchApi(settingsEndpoint, HttpMethod.Put, {
            requestData: {
                ...settings,
                sidebarSorting: sorting,
            },
        });
        updateState({
            sidebarSorting: sorting,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

export async function toggleHideInactive(
    nextValue: boolean,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        await fetchApi(settingsEndpoint, HttpMethod.Put, {
            requestData: {
                ...settings,
                onlyShowRecent: nextValue,
            },
        });
        updateState({
            onlyShowRecent: nextValue,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

/**
 * Options for every AI select: the definitions, preceded by a "use the default" entry carrying
 * {@link defaultAiSelectValue}.
 *
 * `inheritedAiId` is what the thing being created will actually fall back to, which is not always
 * the global default — a new worktree inherits its repo root's override. Empty means nothing sits
 * between the new folder and `settings.defaultAiId`.
 */
export function aiSelectOptions({
    aiDefinitions,
    defaultAiId,
    inheritedAiId,
}: Readonly<{
    aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>;
    defaultAiId: string;
    inheritedAiId?: string | undefined;
}>): ViraDropdownOption[] {
    const defaultName =
        aiDefinitions.find((definition) => definition.id === (inheritedAiId || defaultAiId))
            ?.name ||
        aiDefinitions[0]?.name ||
        '';
    return [
        {
            value: defaultAiSelectValue,
            label: defaultName ? `Default (${defaultName})` : 'Default',
        },
        ...aiDefinitions.map((definition) => {
            return {
                value: definition.id,
                label: definition.name,
            };
        }),
    ];
}

/**
 * Open the "Change AI" picker for a folder, seeded with its current override. Works for a
 * standalone repo, a worktree child, and a worktree root — the root's choice acts as the default
 * its children inherit, so the "Inherit" row names whatever the folder currently falls back to
 * (parent override, else its settings files' default, else the global default). The picker also
 * offers the AIs the folder's settings files define.
 */
export async function openChangeAiModal(
    folder: FolderInfo,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        const override = settings.folderAiIds.find((entry) => entry.folder === folder.path);
        const aiDefinitions = [
            ...settings.aiDefinitions,
            ...folder.folderAiDefinitions,
        ];
        const inherited = aiDefinitions.find(
            (definition) => definition.id === folder.inheritedAiId,
        );
        updateState({
            aiDefinitions,
            defaultAiId: settings.defaultAiId,
            changeAiTarget: {
                folderPath: folder.path,
                selectedAiId: override?.aiId || '',
                inheritedName: inherited?.name || '',
                isWorktreeRoot: folder.isWorktreeRoot,
            },
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

export function showError(updateState: SidebarUpdate, error: unknown): void {
    updateState({
        loadError: extractErrorMessage(error),
    });
}

export async function openAddRepoModal(updateState: SidebarUpdate): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        updateState({
            isAddRepoModalOpen: true,
            aiDefinitions: settings.aiDefinitions,
            defaultAiId: settings.defaultAiId,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

/**
 * Resolve which folder should actually be activated when the user "selects" the given one. For
 * standalone repos the answer is just the folder itself; for worktree-roots the single-segment URL
 * `/<repoName>` is invalid per the router spec (vir-app's `resolveRoute` redirects it to `/`), so
 * we pick the first worktree child as the activation target instead. Falls back to the root if no
 * children exist yet (shouldn't happen — a worktree-root by definition has at least one child).
 */
export function activationTargetFor(
    folder: FolderInfo,
    folders: ReadonlyArray<FolderInfo>,
): FolderInfo {
    if (!folder.isWorktreeRoot) {
        return folder;
    }
    const firstWorktree = folders.find((other) => other.parentRepoPath === folder.path);
    return firstWorktree ?? folder;
}

export async function confirmRemoveRepo({
    repoPath,
    updateState,
    refreshFolderData,
    notifyRemoved,
}: Readonly<{
    repoPath: string;
    updateState: SidebarUpdate;
    refreshFolderData: () => Promise<void>;
    notifyRemoved: () => void;
}>): Promise<void> {
    if (
        !window.confirm(
            [
                `Remove repo ${repoPath}?`,
                'This only removes it from agent-storm; the repo stays on disk.',
            ].join('\n\n'),
        )
    ) {
        return;
    }
    /**
     * Clear app-level selection / opened panes for this repo (and its worktrees) before the API
     * trip so the right pane unmounts immediately instead of waiting for the next folder-info
     * poll.
     */
    notifyRemoved();
    try {
        await fetchApi(removeRepoEndpoint, HttpMethod.Post, {
            requestData: {
                path: repoPath,
            },
        });
        await refreshFolderData();
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

export async function openAddWorktreeModal(
    repoPath: string,
    updateState: SidebarUpdate,
): Promise<void> {
    try {
        const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
        updateState({
            addWorktreeRepoPath: repoPath,
            aiDefinitions: settings.aiDefinitions,
            defaultAiId: settings.defaultAiId,
        });
    } catch (error: unknown) {
        showError(updateState, error);
    }
}

/** The delete confirmation's text, which names the row and warns about work that would be lost. */
export function describeWorktreeDeletion(
    folder: Readonly<Pick<FolderInfo, 'path' | 'name' | 'branch' | 'git'>>,
): string {
    return [
        `Delete worktree "${folder.name}"?`,
        '',
        `Branch: ${folder.branch || '(detached HEAD)'}`,
        `Path: ${folder.path}`,
        ...(folder.git.dirty || folder.git.notPushed
            ? [
                  '',
                  ...(folder.git.dirty
                      ? [
                            '⚠ It has uncommitted changes, which will be lost.',
                        ]
                      : []),
                  ...(folder.git.notPushed
                      ? [
                            '⚠ It has commits that were never pushed. They stay on the local branch.',
                        ]
                      : []),
              ]
            : []),
    ].join('\n');
}

export async function confirmDeleteWorktree({
    folder,
    updateState,
    refreshFolderData,
    removeFolderLocally,
    notifyRemoved,
}: Readonly<{
    folder: Readonly<Pick<FolderInfo, 'path' | 'name' | 'branch' | 'git'>>;
    updateState: SidebarUpdate;
    refreshFolderData: () => Promise<void>;
    removeFolderLocally: (path: string) => void;
    notifyRemoved: () => void;
}>): Promise<void> {
    const worktreePath = folder.path;
    if (!window.confirm(describeWorktreeDeletion(folder))) {
        return;
    }
    /**
     * Optimistically drop the row from the sidebar before the API trip. `git worktree remove
     * --force` plus the subsequent `refreshFolderInfoNow` can take a couple of seconds; without
     * this the row sits stale until the response lands. Adding to `pendingWorktreeDeletions` keeps
     * the 2s background poll from un-removing it while the backend is still chewing through the
     * delete. `notifyRemoved` lets the parent clear `activeFolder` / `openedFolders` entries for
     * this worktree so the right-hand pane unmounts immediately. If the backend rejects the delete
     * the `catch` below re-fetches and the row reappears.
     */
    pendingWorktreeDeletions.add(worktreePath);
    removeFolderLocally(worktreePath);
    notifyRemoved();
    try {
        await fetchApi(deleteWorktreeEndpoint, HttpMethod.Post, {
            requestData: {
                worktreePath,
            },
        });
    } catch (error: unknown) {
        showError(updateState, error);
    } finally {
        pendingWorktreeDeletions.delete(worktreePath);
        await refreshFolderData();
    }
}

export type FolderActionParams = Readonly<{
    folder: FolderInfo;
    /**
     * The worktrees listed under a repo header, which a repo removal reports as removed along with
     * the repo. Empty for a folder row.
     */
    childPaths: ReadonlyArray<string>;
    /** The sidebar's mirror of the saved repos. */
    repos: ReadonlyArray<SavedRepo>;
    updateState: SidebarUpdate;
    removeFolderLocally: (path: string) => void;
    emitFoldersRemoved: (paths: ReadonlyArray<string>) => void;
    emitPaneRestarted: (detail: PaneRestartedEvent) => void;
    emitSettingsRequested: (target: SettingsTarget) => void;
    refreshFolderData: () => Promise<void>;
}>;

export const folderActionHandlers: Record<
    SidebarFolderAction,
    (params: FolderActionParams) => MaybePromise<void>
> = {
    async [SidebarFolderAction.ToggleWatch]({folder, updateState}) {
        try {
            await fetchApi(watchModeEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: folder.path,
                    isEnabled: folder.watchMode.status === WatchModeStatus.Off,
                },
            });
        } catch (error: unknown) {
            showError(updateState, error);
        }
    },
    async [SidebarFolderAction.AddWorktree]({folder, updateState}) {
        await openAddWorktreeModal(folder.path, updateState);
    },
    async [SidebarFolderAction.ChangeAi]({folder, updateState}) {
        await openChangeAiModal(folder, updateState);
    },
    [SidebarFolderAction.OpenSettings]({folder, emitSettingsRequested}) {
        emitSettingsRequested({
            section: SettingsSection.Folders,
            folder: folder.path,
        });
    },
    async [SidebarFolderAction.RestartPanes]({folder, updateState, emitPaneRestarted}) {
        await restartFolderPanes({
            folder: folder.path,
            emitPaneRestarted,
            onError(error) {
                showError(updateState, error);
            },
        });
    },
    async [SidebarFolderAction.KillPanes]({folder, updateState, emitFoldersRemoved}) {
        try {
            await fetchApi(killPanesEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: folder.path,
                },
            });
            /**
             * After a successful kill, treat the folder as no-longer-opened: drop it from
             * `vir-app`'s `openedFolders` (which unmounts its pane group and disposes the
             * terminals) and clear the route if it was the active one. Reusing the `foldersRemoved`
             * event is intentional — vir-app's handler does exactly the openedFolders + route
             * teardown we want, without touching the sidebar's own folders list (the row stays
             * visible). Next click on the same row re-adds it to `openedFolders`, which remounts
             * `VirPaneGroup` / `VirTerminal` and triggers a fresh `/pty` attach so the backend
             * spawns new PTYs.
             */
            emitFoldersRemoved([folder.path]);
        } catch (error: unknown) {
            showError(updateState, error);
        }
    },
    /**
     * Clears the repo's `lastInteractedAtMs`, which the recency filter treats as hidden — the repo
     * drops out of the default sidebar list but still surfaces in search and the unfiltered view.
     * Also kills the folder's panes (same as "Kill panes") so hiding a repo tears down its running
     * PTYs and drops it from `openedFolders`/route via `foldersRemoved`, rather than leaving a
     * hidden-but-running session behind. The local repos mirror is cleared first so the row hides
     * on click instead of after the kill finishes.
     */
    async [SidebarFolderAction.HideRepo]({folder, repos, updateState, emitFoldersRemoved}) {
        const owningRepoPath = folder.parentRepoPath ?? folder.path;
        startRepoHide(folder.path);
        updateState({
            repos: repos.map((repo) => {
                return repo.path === owningRepoPath
                    ? omitObjectKeys(repo, ['lastInteractedAtMs'])
                    : repo;
            }),
        });
        try {
            await fetchApi(hideRepoEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: folder.path,
                },
            });
            await fetchApi(killPanesEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: folder.path,
                },
            });
            emitFoldersRemoved([folder.path]);
        } catch (error: unknown) {
            cancelRepoHide(folder.path);
            showError(updateState, error);
        }
    },
    async [SidebarFolderAction.DeleteWorktree]({
        folder,
        updateState,
        refreshFolderData,
        removeFolderLocally,
        emitFoldersRemoved,
    }) {
        await confirmDeleteWorktree({
            folder,
            updateState,
            refreshFolderData,
            removeFolderLocally,
            notifyRemoved() {
                emitFoldersRemoved([folder.path]);
            },
        });
    },
    async [SidebarFolderAction.RemoveRepo]({
        folder,
        childPaths,
        updateState,
        refreshFolderData,
        emitFoldersRemoved,
    }) {
        await confirmRemoveRepo({
            repoPath: folder.path,
            updateState,
            refreshFolderData,
            notifyRemoved() {
                emitFoldersRemoved([
                    folder.path,
                    ...childPaths,
                ]);
            },
        });
    },
};
