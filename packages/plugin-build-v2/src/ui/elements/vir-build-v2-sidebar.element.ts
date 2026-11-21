// cspell:words unarchive unarchived unarchives unarchiving
import {
    hideRepoEndpoint,
    settingsEndpoint,
    touchRepoEndpoint,
    type Settings,
} from '@agent-storm/common';
import {
    createSettingsTarget,
    defineAppElement,
    fetchApi,
    ScreenSize,
    SettingsSection,
    sidebarContextMenuOffset,
    sidebarFolderMenuStyles,
    VirSidebarSearch,
    type ActivityRoute,
    type AppContext,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {classMap, css, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideChevronDownIcon,
    LucideSquarePenIcon,
    PopoverAnchor,
    PopoverTrigger,
    renderMenuItemEntries,
    tooltip,
    ViraCollapsibleWrapper,
    ViraIcon,
    ViraMenuTrigger,
    viraThemeByKeys,
} from 'vira';
import {type Thread} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {buildV2Memory} from '../../util/build-v2-memory.js';
import {
    confirmThreadArchive,
    findThreadRepos,
    loadArchivedThreads,
    loadThreads,
    markThreadArchived,
    newThreadSubPath,
    storeThread,
    type BuildV2State,
} from '../../util/build-v2-state.js';
import {arrangeRepoGroups} from '../../util/sidebar-groups.js';
import {groupThreadsByRepo} from '../../util/thread-timeline.js';
import {folderSettingsSection} from './build-v2-settings-sections.js';
import {sidebarStatusDisplays} from './thread-display.js';
import {VirBuildV2AddFolderModal} from './vir-build-v2-add-folder-modal.element.js';
import {VirBuildV2SidebarHeader} from './vir-build-v2-sidebar-header.element.js';
import {VirBuildV2ThreadRow} from './vir-build-v2-thread-row.element.js';

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 10);
const newThreadIcon = createSizedIcon(LucideSquarePenIcon, 12);

/** The Build V2 tab's sidebar: every thread, grouped under its repo, with a new-thread button each. */
export const VirBuildV2Sidebar = defineAppElement<{
    context: AppContext;
    route: ActivityRoute;
    buildV2State: Readonly<BuildV2State>;
}>()({
    tagName: 'vir-build-v2-sidebar',
    state() {
        return {
            actionError: undefined as string | undefined,
            collapsedRepoPaths: [] as ReadonlyArray<string>,
            searchQuery: '',
            isAddFolderModalOpen: false,
            /** The title of the thread being unarchived, which can take a while to check out. */
            unarchivingTitle: undefined as string | undefined,
        };
    },
    styles: css`
        ${sidebarFolderMenuStyles}

        :host {
            display: flex;
            flex-direction: column;
            min-height: 0;
        }

        .sidebar {
            display: flex;
            box-sizing: border-box;
            flex-direction: column;
            flex-grow: 1;
            width: 100%;
            min-width: 0;
            min-height: 0;
            overflow-y: auto;
            padding: 4px 0;
            user-select: none;
            -webkit-user-select: none;
        }

        .message {
            padding: 4px 8px;
            font-size: 12px;
            overflow-wrap: anywhere;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.error {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 6px;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            }
        }

        .retry {
            height: 24px;
            padding: 0 8px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            border-radius: 6px;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            font: inherit;
            font-size: 12px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};
            }
        }

        ul {
            display: flex;
            flex-direction: column;
            margin: 0;
            padding: 0;
            list-style: none;
        }

        li {
            list-style: none;
        }

        .project {
            position: relative;
        }

        /* A menu trigger is inline by default, which would shrink the header to its content. */
        .project ${ViraMenuTrigger} {
            display: flex;
            width: 100%;
        }

        .project-header {
            display: flex;
            flex-grow: 1;
            box-sizing: border-box;
            width: 100%;
            height: 22px;
            align-items: center;
            gap: 10px;
            padding: 0 5px;
            background: transparent;
            font: inherit;
            text-align: left;
            color: ${viraThemeByKeys.grey.foreground['highest-contrast'].foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }

            &.drafting {
                background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background
                    .value};
            }

            &.empty-project {
                cursor: default;
            }
        }

        .chevron {
            display: inline-flex;
            flex-shrink: 0;
            transition: transform 120ms;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.collapsed {
                transform: rotate(-90deg);
            }
        }

        .project-label {
            display: flex;
            flex-grow: 1;
            min-width: 0;
            gap: 4px;
        }

        .project-name {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 13px;
            font-weight: 500;
        }

        .folder-dot {
            width: 6px;
            height: 6px;
            flex-shrink: 0;
            border-radius: 50%;
        }

        .screen-reader-only {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }

        .thread-count {
            flex-shrink: 0;
            font-size: 13px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .new-thread-wrapper {
            position: absolute;
            top: 0;
            right: 22px;
            display: flex;
            height: 28px;
            align-items: center;
            opacity: 0;

            &.empty-project {
                right: 2px;
            }
        }

        .project:hover .new-thread-wrapper,
        .new-thread-wrapper:focus-within {
            opacity: 1;
        }

        @media (pointer: coarse) {
            & .new-thread-wrapper {
                opacity: 1;
            }
        }

        .new-thread {
            display: inline-flex;
            width: 24px;
            height: 24px;
            align-items: center;
            justify-content: center;
            border: none;
            border-radius: 6px;
            background: transparent;
            cursor: pointer;
            outline: none;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }
        }
    `,
    render({inputs, state, updateState}) {
        const threads = inputs.buildV2State.threads.value;
        const archivedThreads = inputs.buildV2State.archivedThreads.value;
        const loadError = inputs.buildV2State.loadError.value;
        const draftRepoPath = inputs.buildV2State.draftRepoPath.value;
        const activeThreadId =
            inputs.route.subPaths[0] === newThreadSubPath ? undefined : inputs.route.subPaths[0];
        const allGroups = groupThreadsByRepo({
            repos: findThreadRepos(inputs.context),
            threads: [
                ...(threads || []),
                ...(archivedThreads || []),
            ],
        });
        const snapshot = inputs.context.folderData.value.snapshot;
        const groups = arrangeRepoGroups({
            groups: allGroups,
            folderInfo: inputs.context.folderData.value.folderInfo,
            archivedThreadIds: (archivedThreads || []).map((thread) => thread.id),
            repos: snapshot?.repos || [],
            sorting: snapshot?.settings.sidebarSorting,
            onlyShowRecent: snapshot?.settings.onlyShowRecent,
            searchQuery: state.searchQuery,
        });
        const isSearching = !!state.searchQuery.trim();

        async function runAction(action: () => Promise<void>) {
            try {
                updateState({
                    actionError: undefined,
                });
                await action();
            } catch (error) {
                updateState({
                    actionError: extractErrorMessage(error),
                });
            }
        }

        /** Counts as use of the folder for the "Hide Inactive" filter, which both sidebars share. */
        function touchFolder(folder: string) {
            void fetchApi(touchRepoEndpoint, HttpMethod.Post, {
                requestData: {
                    folder,
                },
            }).catch(() => undefined);
        }

        async function updateSettings(change: Readonly<Partial<Settings>>) {
            await runAction(async () => {
                const settings = await fetchApi(settingsEndpoint, HttpMethod.Get);
                await fetchApi(settingsEndpoint, HttpMethod.Put, {
                    requestData: {
                        ...settings,
                        ...change,
                    },
                });
                await inputs.context.folderData.refresh();
            });
        }

        /** A worktree root's changes show on each worktree's thread instead. */
        function isRepoDirty(repoPath: string) {
            const info = inputs.context.folderData.value.folderInfo.get(repoPath);
            return !!info && !info.isWorktreeRoot && info.git.dirty;
        }

        function startDraft(repoPath: string) {
            touchFolder(repoPath);
            inputs.buildV2State.draftRepoPath.setValue(repoPath);
            inputs.route.navigate([
                newThreadSubPath,
            ]);
        }

        /** Opening a thread counts as reading it, even when its AI chat pane isn't shown. */
        async function selectThread(thread: Readonly<Thread>) {
            touchFolder(thread.repoPath);
            inputs.buildV2State.draftRepoPath.setValue(undefined);
            buildV2Memory.selectedThread.write(thread.id);
            inputs.route.navigate([
                thread.id,
            ]);
            if (thread.hasUnreadReply) {
                await runAction(async () => {
                    await buildV2Client.call('markThreadRead', {
                        threadId: thread.id,
                    });
                });
            }
        }

        function isArchived(thread: Readonly<Thread>) {
            return !!archivedThreads?.some((archived) => archived.id === thread.id);
        }

        async function unarchiveThread(thread: Readonly<Thread>) {
            /** A second click would recreate the same missing worktree again. */
            if (state.unarchivingTitle) {
                return;
            }
            updateState({
                unarchivingTitle: thread.title || 'New thread',
            });
            await runAction(async () => {
                const unarchived = await buildV2Client.call('unarchiveThread', {
                    threadId: thread.id,
                });
                storeThread(inputs.buildV2State, unarchived.thread);
                await selectThread(unarchived.thread);
            });
            updateState({
                unarchivingTitle: undefined,
            });
        }

        return html`
            <${VirBuildV2SidebarHeader.assign({
                mobileModal: inputs.context.screenSize === ScreenSize.Mobile,
                searchQuery: state.searchQuery,
                hasSearchResult: isSearching && !!groups.length,
                sidebarSorting: snapshot?.settings.sidebarSorting,
                onlyShowRecent: snapshot?.settings.onlyShowRecent,
                showArchived: !!archivedThreads,
                themeClient: inputs.context.themeClient,
            })}
                ${listen(VirSidebarSearch.events.searchQueryChange, (event) => {
                    updateState({
                        searchQuery: event.detail,
                    });
                })}
                ${listen(VirSidebarSearch.events.searchSubmit, async () => {
                    const [firstGroup] = groups;
                    const [firstThread] = firstGroup?.threads || [];
                    if (firstThread) {
                        await selectThread(firstThread);
                    } else if (firstGroup) {
                        startDraft(firstGroup.repo.path);
                    }
                })}
                ${listen(VirBuildV2SidebarHeader.events.addFolderRequest, () => {
                    updateState({
                        isAddFolderModalOpen: true,
                    });
                })}
                ${listen(VirBuildV2SidebarHeader.events.sortingSelect, async (event) => {
                    await updateSettings({
                        sidebarSorting: event.detail,
                    });
                })}
                ${listen(VirBuildV2SidebarHeader.events.hideInactiveChange, async (event) => {
                    await updateSettings({
                        onlyShowRecent: event.detail,
                    });
                })}
                ${listen(VirBuildV2SidebarHeader.events.showArchivedChange, async (event) => {
                    if (event.detail) {
                        inputs.buildV2State.archivedThreads.setValue([]);
                        await loadArchivedThreads(inputs.buildV2State);
                    } else {
                        inputs.buildV2State.archivedThreads.setValue(undefined);
                    }
                })}
                ${listen(VirBuildV2SidebarHeader.events.settingsRequest, () => {
                    inputs.context.openSettings({
                        section: SettingsSection.General,
                    });
                })}
            ></${VirBuildV2SidebarHeader}>
            <div class="sidebar">
                ${loadError
                    ? html`
                          <div class="message error">
                              Can't load threads: ${loadError}
                              <button
                                  type="button"
                                  class="retry"
                                  ${listen('click', async () => {
                                      await loadThreads(inputs.buildV2State);
                                  })}
                              >
                                  Retry
                              </button>
                          </div>
                      `
                    : nothing}
                ${state.actionError
                    ? html`
                          <div class="message error">${state.actionError}</div>
                      `
                    : nothing}
                ${state.unarchivingTitle
                    ? html`
                          <div class="message">Unarchiving "${state.unarchivingTitle}"…</div>
                      `
                    : nothing}
                ${threads || loadError
                    ? nothing
                    : html`
                          <div class="message">Loading threads…</div>
                      `}
                ${allGroups.length || !threads
                    ? nothing
                    : html`
                          <div class="message">
                              No projects yet. Add a folder to start a thread in it.
                          </div>
                      `}
                ${groups.length || !allGroups.length
                    ? nothing
                    : html`
                          <div class="message">
                              ${isSearching
                                  ? 'No matching folders or threads.'
                                  : 'No recently active folders. Toggle Hide Inactive to show all.'}
                          </div>
                      `}
                <ul>
                    ${groups.map((group) => {
                        /** A collapsed folder would hide the threads a search matched. */
                        const isCollapsed =
                            !isSearching && state.collapsedRepoPaths.includes(group.repo.path);
                        const isDrafting =
                            draftRepoPath === group.repo.path &&
                            inputs.route.subPaths[0] === newThreadSubPath;
                        const folderDot = isCollapsed
                            ? group.threads
                                  .map((thread) => sidebarStatusDisplays[thread.status].folderDot)
                                  .find((dot) => dot)
                            : undefined;
                        /** Counted before search filtering, like the Build tab's repo count. */
                        const threadCount =
                            allGroups.find((entry) => entry.repo.path === group.repo.path)?.threads
                                .length ?? group.threads.length;
                        return html`
                            <li class="project">
                                <${ViraCollapsibleWrapper.assign({
                                    expanded: !isCollapsed,
                                })}
                                    ${listen(
                                        ViraCollapsibleWrapper.events.expandChange,
                                        (event) => {
                                            if (!group.threads.length) {
                                                return;
                                            }
                                            updateState({
                                                collapsedRepoPaths: event.detail
                                                    ? state.collapsedRepoPaths.filter(
                                                          (path) => path !== group.repo.path,
                                                      )
                                                    : [
                                                          ...state.collapsedRepoPaths,
                                                          group.repo.path,
                                                      ],
                                            });
                                        },
                                    )}
                                >
                                    <${ViraMenuTrigger.assign({
                                        trigger: PopoverTrigger.ContextMenu,
                                        popoverAnchor: PopoverAnchor.Mouse,
                                        popoverOffset: sidebarContextMenuOffset,
                                    })}
                                        slot=${ViraCollapsibleWrapper.slotNames[
                                            'vira-collapsible-wrapper-header'
                                        ]}
                                        ${listen('click', (event) => {
                                            /**
                                             * The menu sits inside the collapsible header's button,
                                             * so a click on a menu item would otherwise also
                                             * collapse or expand the project.
                                             */
                                            const isHeaderClick = event
                                                .composedPath()
                                                .some((target) => {
                                                    return (
                                                        target instanceof HTMLElement &&
                                                        target.classList.contains('project-header')
                                                    );
                                                });
                                            if (!isHeaderClick) {
                                                event.stopPropagation();
                                            }
                                        })}
                                    >
                                        <div
                                            class=${classMap({
                                                'project-header': true,
                                                drafting: isDrafting,
                                                'empty-project': !group.threads.length,
                                            })}
                                            ${tooltip(group.repo.path)}
                                            data-sidebar-search-result
                                            slot=${ViraMenuTrigger.slotNames[
                                                'vira-menu-trigger-trigger'
                                            ]}
                                        >
                                            <span class="project-label">
                                                <span class="project-name">
                                                    ${group.repo.name}${isRepoDirty(group.repo.path)
                                                        ? '*'
                                                        : ''}
                                                </span>
                                                ${threadCount > 1
                                                    ? html`
                                                          <span class="thread-count">
                                                              (${threadCount})
                                                          </span>
                                                      `
                                                    : nothing}
                                            </span>
                                            ${folderDot
                                                ? html`
                                                      <span
                                                          class="folder-dot"
                                                          style=${css`
                                                              background-color: ${viraThemeByKeys[
                                                                  folderDot.color
                                                              ].foreground.body.foreground.value};
                                                          `}
                                                      >
                                                          <span class="screen-reader-only">
                                                              ${folderDot.label}
                                                          </span>
                                                      </span>
                                                  `
                                                : nothing}
                                            ${group.threads.length
                                                ? html`
                                                      <span
                                                          class=${classMap({
                                                              chevron: true,
                                                              collapsed: isCollapsed,
                                                          })}
                                                      >
                                                          <${ViraIcon.assign({
                                                              icon: chevronIcon,
                                                          })}></${ViraIcon}>
                                                      </span>
                                                  `
                                                : nothing}
                                        </div>
                                        ${renderMenuItemEntries([
                                            {
                                                content: 'New thread',
                                                onClick() {
                                                    startDraft(group.repo.path);
                                                },
                                            },
                                            {
                                                content: 'Settings',
                                                onClick() {
                                                    inputs.context.openSettings(
                                                        createSettingsTarget({
                                                            section: folderSettingsSection,
                                                            details: {
                                                                folder: group.repo.path,
                                                            },
                                                        }),
                                                    );
                                                },
                                            },
                                            {
                                                content: 'Hide folder',
                                                async onClick() {
                                                    await runAction(async () => {
                                                        await fetchApi(
                                                            hideRepoEndpoint,
                                                            HttpMethod.Post,
                                                            {
                                                                requestData: {
                                                                    folder: group.repo.path,
                                                                },
                                                            },
                                                        );
                                                        await inputs.context.folderData.refresh();
                                                    });
                                                },
                                            },
                                        ])}
                                    </${ViraMenuTrigger}>
                                    <ul>
                                        ${group.threads.map((thread) => {
                                            return html`
                                                <li data-sidebar-search-result>
                                                    <${VirBuildV2ThreadRow.assign({
                                                        thread,
                                                        folderInfo:
                                                            inputs.context.folderData.value.folderInfo.get(
                                                                thread.cwd,
                                                            ),
                                                        isActive: thread.id === activeThreadId,
                                                        isArchived: isArchived(thread),
                                                        sideChats:
                                                            inputs.buildV2State.sideChats.value.filter(
                                                                (sideChat) => {
                                                                    return (
                                                                        sideChat.parentThreadId ===
                                                                        thread.id
                                                                    );
                                                                },
                                                            ),
                                                    })}
                                                        ${listen(
                                                            VirBuildV2ThreadRow.events.selected,
                                                            async () => {
                                                                await selectThread(thread);
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildV2ThreadRow.events.unarchived,
                                                            async () => {
                                                                await unarchiveThread(thread);
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildV2ThreadRow.events.renamed,
                                                            async (event) => {
                                                                await runAction(async () => {
                                                                    const renamed =
                                                                        await buildV2Client.call(
                                                                            'renameThread',
                                                                            {
                                                                                threadId: thread.id,
                                                                                title: event.detail,
                                                                            },
                                                                        );
                                                                    storeThread(
                                                                        inputs.buildV2State,
                                                                        renamed.thread,
                                                                    );
                                                                });
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildV2ThreadRow.events.archived,
                                                            async () => {
                                                                if (
                                                                    !(await confirmThreadArchive({
                                                                        context: inputs.context,
                                                                        thread,
                                                                    }))
                                                                ) {
                                                                    return;
                                                                }
                                                                await runAction(async () => {
                                                                    await buildV2Client.call(
                                                                        'archiveThread',
                                                                        {
                                                                            threadId: thread.id,
                                                                            deleteWorktree: true,
                                                                        },
                                                                    );
                                                                    markThreadArchived(
                                                                        inputs.buildV2State,
                                                                        thread.id,
                                                                    );
                                                                    if (
                                                                        thread.id === activeThreadId
                                                                    ) {
                                                                        inputs.route.navigate([]);
                                                                    }
                                                                });
                                                            },
                                                        )}
                                                    ></${VirBuildV2ThreadRow}>
                                                </li>
                                            `;
                                        })}
                                    </ul>
                                </${ViraCollapsibleWrapper}>
                                <span
                                    class=${classMap({
                                        'new-thread-wrapper': true,
                                        'empty-project': !group.threads.length,
                                    })}
                                >
                                    <button
                                        type="button"
                                        class="new-thread"
                                        aria-label=${`New thread in ${group.repo.name}`}
                                        ${tooltip(`New thread in ${group.repo.name}`)}
                                        ${listen('click', () => {
                                            startDraft(group.repo.path);
                                        })}
                                    >
                                        <${ViraIcon.assign({
                                            icon: newThreadIcon,
                                        })}></${ViraIcon}>
                                    </button>
                                </span>
                            </li>
                        `;
                    })}
                </ul>
            </div>
            <${VirBuildV2AddFolderModal.assign({
                open: state.isAddFolderModalOpen,
            })}
                ${listen(VirBuildV2AddFolderModal.events.close, () => {
                    updateState({
                        isAddFolderModalOpen: false,
                    });
                })}
                ${listen(VirBuildV2AddFolderModal.events.errorReport, (event) => {
                    updateState({
                        actionError: event.detail,
                    });
                })}
                ${listen(VirBuildV2AddFolderModal.events.folderAdd, async (event) => {
                    await inputs.context.folderData.refresh();
                    startDraft(event.detail);
                })}
            ></${VirBuildV2AddFolderModal}>
        `;
    },
});
