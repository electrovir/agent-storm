import {type FolderInfo, PaneStatus, type PrStatus, SidebarSorting} from '@agent-storm/common';
import {colorCss} from '@electrovir/color';
import {getNowInUtcTimezone, toTimestamp} from 'date-vir';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {tooltip, viraThemeByKeys, type ViraThemeClient} from 'vira';
import {type FolderDataObservable} from '../../util/folder-data.js';
import {type PaneRestartedEvent} from '../../util/restart-folder-panes.js';
import {sidebarTooltipOptions} from '../../util/sidebar-display.js';
import {defineAppElement} from '../define-app-element.js';
import {VirSidebarAddRepoModal} from './vir-sidebar-add-repo-modal.element.js';
import {VirSidebarAddWorktreeModal} from './vir-sidebar-add-worktree-modal.element.js';
import {VirSidebarBuildSettingsModal} from './vir-sidebar-build-settings-modal.element.js';
import {VirSidebarChangeAiModal} from './vir-sidebar-change-ai-modal.element.js';
import {VirSidebarHeader} from './vir-sidebar-header.element.js';
import {VirSidebarRepoHeader} from './vir-sidebar-repo-header.element.js';
import {VirSidebarRow} from './vir-sidebar-row.element.js';

import {
    folderActionHandlers,
    openAddRepoModal,
    setSidebarGrouping,
    setSidebarSorting,
    toggleHideInactive,
} from './sidebar-actions.js';
import {filterByRecency, filterBySearch, folderComparators} from './sidebar-folder-filter.js';
import {type SidebarFolderAction} from './sidebar-menus.js';
import {folderDataState, pendingWorktreeDeletions, type SidebarState} from './sidebar-state.js';

export const VirSidebar = defineAppElement<{
    activeFolder: string | undefined;
    /** The app's shared folder poll, which this sidebar's list and menus read from. */
    folderData: FolderDataObservable;
    hideBorder?: boolean | undefined;
    mobileModal?: boolean | undefined;
    /**
     * PR statuses to show instead of the polled ones, by folder path, while GitHub catches up with
     * a verdict that was just sent.
     */
    prStatusOverrides?: Readonly<Record<string, PrStatus>> | undefined;
    /** App-owned Vira theme client, used by the options menu's theme switcher. */
    themeClient: Readonly<ViraThemeClient>;
    /** Shown beside the brand mark. */
    heading?: string | undefined;
}>()({
    tagName: 'vir-sidebar',
    events: {
        /**
         * Emitted when the user clicks a folder row or when an internal action (e.g. creating a
         * worktree) wants to make the new folder the active one. Detail is the absolute folder
         * path. Parent owns the `activeFolder` / `openedFolders` state, so it listens for this and
         * updates accordingly.
         */
        folderActivated: defineElementEvent<string>(),
        /**
         * Emitted just after the user confirms a worktree-delete or repo-remove, before the API
         * trip starts. The detail carries every folder path that is now gone (the removed item
         * plus, for repo removal, all of its worktree children). The parent listens to clear
         * `activeFolder` if it pointed at one of them and drop them from `openedFolders` so the
         * right-hand pane unmounts immediately instead of waiting for the next folder-info poll.
         */
        foldersRemoved: defineElementEvent<ReadonlyArray<string>>(),
        /** Emitted after a pane restart succeeds so the mounted terminal can reconnect. */
        paneRestarted: defineElementEvent<PaneRestartedEvent>(),
        /** Emitted when the user clicks the gear button. Parent owns the modal open state. */
        openSettingsRequested: defineElementEvent<void>(),
        /** Same deal for the "Define AI" item, which the parent renders as its own modal. */
        openAiModalRequested: defineElementEvent<void>(),
    },
    state(): SidebarState {
        return {
            folders: [],
            removeFolderDataListener: undefined,
            loadError: undefined,
            openMenuKey: undefined,
            isAddRepoModalOpen: false,
            addWorktreeRepoPath: undefined,
            changeAiTarget: undefined,
            buildSettingsTarget: undefined,
            aiDefinitions: [],
            defaultAiId: '',
            sidebarGrouping: undefined,
            sidebarSorting: undefined,
            onlyShowRecent: undefined,
            searchQuery: '',
            repos: [],
            updateStatus: undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-size: 12px;
            border-right: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        :host([data-hide-border]) {
            border-right: none;
        }

        :host([data-mobile-modal]) {
            width: 100%;
            font-size: 15px;
        }

        .list {
            flex-grow: 1;
            /* min-height: 0 lets this flex child shrink below its content height so it scrolls
               within the column instead of pushing the host taller (now that the host no longer
               clips). overflow-x: hidden keeps long folder names clipped to the sidebar width. */
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 4px 0 32px;
            font-size: 13px;
            font-weight: 300;
            letter-spacing: 0.01em;
        }

        .error {
            padding: 8px 5px;
            ${colorCss(viraThemeByKeys.red['behind-bg'].body)};
            border-bottom: 1px solid ${viraThemeByKeys.red['behind-bg'].decoration.background.value};
            white-space: pre-wrap;
        }

        .update-banner {
            flex-shrink: 0;
            padding: 6px 5px;
            font-size: 11px;
            text-align: center;
            /**
             * The vira palette has no "orange" key — yellow is the warning slot and reads as
             * orange-adjacent in both light and dark modes, which matches the user's intent
             * (attention-grabbing but not error-red).
             */
            ${colorCss(viraThemeByKeys.yellow['behind-bg'].body)};
            border-top: 1px solid ${viraThemeByKeys.yellow['behind-bg'].decoration.background.value};
        }

        :host([data-mobile-modal]) .update-banner {
            font-size: 13px;
            padding: 10px 16px;
        }

        .empty {
            padding: 16px 10px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            text-align: center;
        }

        :host([data-mobile-modal]) .list {
            font-size: 16px;
        }
    `,
    init({inputs, updateState}) {
        updateState({
            removeFolderDataListener: inputs.folderData.listen(true, (folderData) => {
                updateState(folderDataState(folderData));
            }),
        });
    },
    cleanup({state}) {
        state.removeFolderDataListener?.();
    },
    render({inputs, state, updateState, host, dispatch, events}) {
        if (inputs.hideBorder) {
            host.setAttribute('data-hide-border', '');
        } else {
            host.removeAttribute('data-hide-border');
        }
        if (inputs.mobileModal) {
            host.setAttribute('data-mobile-modal', '');
        } else {
            host.removeAttribute('data-mobile-modal');
        }

        /**
         * Apply the active filter once up front. The standalone list, the worktree roots, and each
         * root's children all iterate this same pre-filtered array so hidden entries disappear
         * consistently and the empty-state message below stays accurate. An active search query
         * wins over the hide-inactive filter (search spans active and inactive repos alike).
         */
        const trimmedSearchQuery = state.searchQuery.trim();
        const shownFolders = state.folders.map((folder) => {
            const prStatus = inputs.prStatusOverrides?.[folder.path];
            return prStatus
                ? {
                      ...folder,
                      prStatus,
                  }
                : folder;
        });
        const visibleFolders = trimmedSearchQuery
            ? filterBySearch(shownFolders, trimmedSearchQuery)
            : state.onlyShowRecent
              ? filterByRecency(shownFolders, state.repos)
              : shownFolders;
        const folderComparator = folderComparators[state.sidebarSorting ?? SidebarSorting.Name];
        const standaloneFolders = visibleFolders
            .filter((folder) => !folder.isWorktreeRoot && !folder.parentRepoPath)
            .toSorted(folderComparator);
        /** See {@link folderComparators} for why repo headers ignore the selected sorting. */
        const worktreeRoots = visibleFolders
            .filter((folder) => folder.isWorktreeRoot)
            .toSorted(folderComparators[SidebarSorting.Name]);
        function sortedChildrenOf(rootPath: string) {
            return visibleFolders
                .filter((folder) => folder.parentRepoPath === rootPath)
                .toSorted(folderComparator);
        }
        /**
         * What Enter in the search input opens: the first row of the rendered list, in the same
         * top-to-bottom order the user sees. Repo headers are skipped because they aren't
         * activatable — a repo with matching worktrees hands off to its first worktree.
         */
        const firstSearchResult = trimmedSearchQuery
            ? (standaloneFolders[0] ??
              worktreeRoots.flatMap((root) => sortedChildrenOf(root.path))[0])
            : undefined;
        /**
         * Closes over `state.folders` from the latest render so the optimistic-delete handler can
         * filter against the freshest snapshot without having to ask for a re-read.
         */
        function removeFolderLocally(path: string) {
            updateState({
                folders: state.folders.filter((folder) => folder.path !== path),
            });
        }
        /**
         * Fire the `foldersRemoved` event so the parent can drop `activeFolder` / `openedFolders`
         * entries pointing at the gone folders. Used by the delete-worktree and remove-repo flows
         * after the user confirms but before the API trip.
         */
        function emitFoldersRemoved(paths: ReadonlyArray<string>) {
            dispatch(
                new events.foldersRemoved({
                    detail: paths,
                }),
            );
        }
        function emitFolderActivated(path: string) {
            /**
             * Optimistically bump the owning repo's `lastInteractedAtMs` in the local repos mirror
             * so the hide-inactive filter keeps the repo visible the instant the search query is
             * cleared and the view reverts to the recency filter. The backend touch — fired from
             * vir-app's `folderActivated` handler — persists this, but it's async and wouldn't land
             * before the re-filter, so an inactive repo would otherwise vanish until the next poll.
             * Resolve the owning repo the same way the backend does: a worktree's parent repo, else
             * the folder itself.
             */
            const folder = state.folders.find((entry) => entry.path === path);
            const owningRepoPath = folder?.parentRepoPath ?? folder?.path ?? path;
            const now = toTimestamp(getNowInUtcTimezone());
            updateState({
                /**
                 * Clear the active search once the user picks a folder — they've found what they
                 * were looking for, so the sidebar reverts to its normal (hide-inactive) view.
                 */
                searchQuery: '',
                repos: state.repos.map((repo) => {
                    return repo.path === owningRepoPath
                        ? {
                              ...repo,
                              lastInteractedAtMs: now,
                          }
                        : repo;
                }),
            });
            dispatch(
                new events.folderActivated({
                    detail: path,
                }),
            );
        }
        function emitPaneRestarted(detail: PaneRestartedEvent) {
            dispatch(
                new events.paneRestarted({
                    detail,
                }),
            );
        }
        function showFolders(folders: ReadonlyArray<FolderInfo>) {
            updateState({
                folders: pendingWorktreeDeletions.size
                    ? folders.filter((folder) => !pendingWorktreeDeletions.has(folder.path))
                    : folders,
                loadError: undefined,
            });
        }
        async function runFolderAction({
            folder,
            childPaths,
            action,
        }: Readonly<{
            folder: FolderInfo;
            childPaths: ReadonlyArray<string>;
            action: SidebarFolderAction;
        }>) {
            await folderActionHandlers[action]({
                folder,
                childPaths,
                updateState,
                removeFolderLocally,
                emitFoldersRemoved,
                emitPaneRestarted,
                refreshFolderData: inputs.folderData.refresh,
            });
        }
        function rowTemplate(folder: FolderInfo, isIndented: boolean) {
            const rowMenuKey = `row:${folder.path}`;
            return html`
                <${VirSidebarRow.assign({
                    folder,
                    isActive: inputs.activeFolder === folder.path,
                    isIndented,
                    isMenuOpen: state.openMenuKey === rowMenuKey,
                    mobileModal: inputs.mobileModal,
                })}
                    ${listen(VirSidebarRow.events.activate, (event) => {
                        event.stopImmediatePropagation();
                        emitFolderActivated(folder.path);
                    })}
                    ${listen(VirSidebarRow.events.menuOpenChange, (event) => {
                        updateState({
                            openMenuKey: event.detail ? rowMenuKey : undefined,
                        });
                    })}
                    ${listen(VirSidebarRow.events.actionSelect, async (event) => {
                        await runFolderAction({
                            folder,
                            childPaths: [],
                            action: event.detail,
                        });
                    })}
                ></${VirSidebarRow}>
            `;
        }
        const changeAiFolderPath = state.changeAiTarget?.folderPath;

        return html`
            <${VirSidebarHeader.assign({
                heading: inputs.heading,
                mobileModal: inputs.mobileModal,
                searchQuery: state.searchQuery,
                hasSearchResult: !!firstSearchResult,
                sidebarGrouping: state.sidebarGrouping,
                sidebarSorting: state.sidebarSorting,
                onlyShowRecent: state.onlyShowRecent,
                themeClient: inputs.themeClient,
            })}
                ${listen(VirSidebarHeader.events.searchQueryChange, (event) => {
                    updateState({
                        searchQuery: event.detail,
                    });
                })}
                ${listen(VirSidebarHeader.events.searchSubmit, () => {
                    if (firstSearchResult) {
                        emitFolderActivated(firstSearchResult.path);
                    }
                })}
                ${listen(VirSidebarHeader.events.addRepoRequest, async () => {
                    await openAddRepoModal(updateState);
                })}
                ${listen(VirSidebarHeader.events.groupingSelect, async (event) => {
                    await setSidebarGrouping(event.detail, updateState);
                })}
                ${listen(VirSidebarHeader.events.sortingSelect, async (event) => {
                    await setSidebarSorting(event.detail, updateState);
                })}
                ${listen(VirSidebarHeader.events.hideInactiveChange, async (event) => {
                    await toggleHideInactive(event.detail, updateState);
                })}
                ${listen(VirSidebarHeader.events.defineAiRequest, (event) => {
                    event.stopImmediatePropagation();
                    dispatch(
                        new events.openAiModalRequested({
                            detail: undefined,
                        }),
                    );
                })}
                ${listen(VirSidebarHeader.events.settingsRequest, (event) => {
                    event.stopImmediatePropagation();
                    dispatch(
                        new events.openSettingsRequested({
                            detail: undefined,
                        }),
                    );
                })}
            ></${VirSidebarHeader}>
            ${state.loadError
                ? html`
                      <div class="error">${state.loadError}</div>
                  `
                : nothing}
            <div class="list">
                ${visibleFolders.length === 0 && !state.loadError
                    ? html`
                          <div class="empty">
                              ${state.folders.length === 0
                                  ? 'No repos configured. Click + to add one.'
                                  : 'No recently active repos. Toggle Hide Inactive to show all.'}
                          </div>
                      `
                    : nothing}
                ${repeat(
                    standaloneFolders,
                    (folder) => folder.path,
                    (folder) => rowTemplate(folder, false),
                )}
                ${repeat(
                    worktreeRoots,
                    (root) => root.path,
                    (root) => {
                        const children = sortedChildrenOf(root.path);
                        const repoMenuKey = `repo:${root.path}`;
                        return html`
                            <${VirSidebarRepoHeader.assign({
                                root,
                                /**
                                 * Counted from the unfiltered list so the number is the repo's real
                                 * worktree count, not however many survived the current filters.
                                 */
                                worktreeCount: state.folders.filter(
                                    (folder) => folder.parentRepoPath === root.path,
                                ).length,
                                isMenuOpen: state.openMenuKey === repoMenuKey,
                                mobileModal: inputs.mobileModal,
                            })}
                                ${listen(VirSidebarRepoHeader.events.menuOpenChange, (event) => {
                                    updateState({
                                        openMenuKey: event.detail ? repoMenuKey : undefined,
                                    });
                                })}
                                ${listen(
                                    VirSidebarRepoHeader.events.actionSelect,
                                    async (event) => {
                                        await runFolderAction({
                                            folder: root,
                                            childPaths: children.map((child) => child.path),
                                            action: event.detail,
                                        });
                                    },
                                )}
                            ></${VirSidebarRepoHeader}>
                            ${repeat(
                                children,
                                (child) => child.path,
                                (child) => rowTemplate(child, true),
                            )}
                        `;
                    },
                )}
            </div>
            ${state.updateStatus?.isUpToDate === false
                ? html`
                      <div
                          class="update-banner"
                          ${tooltip(
                              'Run `git pull` in your agent-storm checkout.',
                              sidebarTooltipOptions,
                          )}
                      >
                          pull from github to update
                      </div>
                  `
                : nothing}
            <${VirSidebarAddRepoModal.assign({
                open: state.isAddRepoModalOpen,
                aiDefinitions: state.aiDefinitions,
                defaultAiId: state.defaultAiId,
            })}
                ${listen(VirSidebarAddRepoModal.events.close, () => {
                    updateState({
                        isAddRepoModalOpen: false,
                    });
                })}
                ${listen(VirSidebarAddRepoModal.events.errorReport, (event) => {
                    updateState({
                        loadError: event.detail,
                    });
                })}
                ${listen(VirSidebarAddRepoModal.events.foldersChange, (event) => {
                    showFolders(event.detail);
                })}
                ${listen(VirSidebarAddRepoModal.events.reposChange, (event) => {
                    updateState({
                        repos: event.detail,
                    });
                })}
                ${listen(VirSidebarAddRepoModal.events.folderActivate, (event) => {
                    event.stopImmediatePropagation();
                    emitFolderActivated(event.detail);
                })}
            ></${VirSidebarAddRepoModal}>
            <${VirSidebarAddWorktreeModal.assign({
                repoPath: state.addWorktreeRepoPath,
                aiDefinitions: state.aiDefinitions,
                defaultAiId: state.defaultAiId,
                inheritedAiId: state.folders.find(
                    (folder) => folder.path === state.addWorktreeRepoPath,
                )?.aiId,
            })}
                ${listen(VirSidebarAddWorktreeModal.events.close, () => {
                    updateState({
                        addWorktreeRepoPath: undefined,
                    });
                })}
                ${listen(VirSidebarAddWorktreeModal.events.errorReport, (event) => {
                    updateState({
                        loadError: event.detail,
                    });
                })}
                ${listen(VirSidebarAddWorktreeModal.events.foldersChange, (event) => {
                    showFolders(event.detail);
                })}
                ${listen(VirSidebarAddWorktreeModal.events.folderActivate, (event) => {
                    event.stopImmediatePropagation();
                    emitFolderActivated(event.detail);
                })}
            ></${VirSidebarAddWorktreeModal}>
            <${VirSidebarChangeAiModal.assign({
                target: state.changeAiTarget,
                aiDefinitions: state.aiDefinitions,
                hasRunningAiPane:
                    !!changeAiFolderPath &&
                    state.folders.find((folder) => folder.path === changeAiFolderPath)?.panes.ai !==
                        PaneStatus.None,
            })}
                ${listen(VirSidebarChangeAiModal.events.close, () => {
                    updateState({
                        changeAiTarget: undefined,
                    });
                })}
                ${listen(VirSidebarChangeAiModal.events.save, async () => {
                    updateState({
                        changeAiTarget: undefined,
                    });
                    await inputs.folderData.refresh();
                })}
                ${listen(VirSidebarChangeAiModal.events.paneRestart, (event) => {
                    event.stopImmediatePropagation();
                    emitPaneRestarted(event.detail);
                })}
                ${listen(VirSidebarChangeAiModal.events.errorReport, (event) => {
                    updateState({
                        loadError: event.detail,
                    });
                })}
            ></${VirSidebarChangeAiModal}>
            <${VirSidebarBuildSettingsModal.assign({
                target: state.buildSettingsTarget,
            })}
                ${listen(VirSidebarBuildSettingsModal.events.close, () => {
                    updateState({
                        buildSettingsTarget: undefined,
                    });
                })}
            ></${VirSidebarBuildSettingsModal}>
        `;
    },
});
