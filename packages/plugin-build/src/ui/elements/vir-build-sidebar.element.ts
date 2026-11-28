// cspell:words unarchive unarchived unarchives unarchiving
import {
    hideRepoEndpoint,
    removeRepoEndpoint,
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
import {reviewClient} from '@agent-storm/plugin-review';
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
import {type Thread} from '../../build-api.js';
import {buildClient} from '../../util/build-client.js';
import {buildMemory} from '../../util/build-memory.js';
import {
    confirmThreadArchive,
    findThreadRepos,
    loadArchivedThreads,
    loadThreads,
    markThreadArchived,
    newThreadSubPath,
    storeThread,
    type BuildState,
} from '../../util/build-state.js';
import {arrangeRepoGroups} from '../../util/sidebar-groups.js';
import {createThreadLookup, groupThreadsByRepo} from '../../util/thread-timeline.js';
import {folderSettingsSection} from './build-settings-sections.js';
import {sidebarStatusDisplays} from './thread-display.js';
import {VirBuildAddFolderModal} from './vir-build-add-folder-modal.element.js';
import {VirBuildSidebarHeader} from './vir-build-sidebar-header.element.js';
import {VirBuildThreadRow} from './vir-build-thread-row.element.js';

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 10);
const newThreadIcon = createSizedIcon(LucideSquarePenIcon, 12);

/** The Build tab's sidebar: every thread, grouped under its repo, with a new-thread button each. */
export const VirBuildSidebar = defineAppElement<{
    context: AppContext;
    route: ActivityRoute;
    buildState: Readonly<BuildState>;
}>()({
    tagName: 'vir-build-sidebar',
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
        }

        /* Only the chevron collapses the folder, so it gets a hit area bigger than its icon. */
        .chevron {
            display: inline-flex;
            flex-shrink: 0;
            /* Any larger and it reaches past the header's padding, overflowing the sidebar. */
            margin: -5px;
            padding: 5px;
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
            height: 22px;
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
        const threads = inputs.buildState.threads.value;
        const archivedThreads = inputs.buildState.archivedThreads.value;
        const archivedThreadIds = new Set(archivedThreads?.map((thread) => thread.id));
        const findSideChats = createThreadLookup(
            inputs.buildState.sideChats.value,
            (sideChat) => sideChat.parentThreadId,
        );
        const findPaneThreads = createThreadLookup(
            inputs.buildState.paneThreads.value,
            (paneThread) => paneThread.cwd,
        );
        const loadError = inputs.buildState.loadError.value;
        const draftRepoPath = inputs.buildState.draftRepoPath.value;
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
            archivedThreadIds,
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
            return fetchApi(touchRepoEndpoint, HttpMethod.Post, {
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

        /**
         * Leaves the search only once the folder data holds the touch, so a folder hidden as
         * inactive doesn't drop out of the sidebar in between.
         */
        async function startDraft(repoPath: string) {
            inputs.buildState.draftRepoPath.setValue(repoPath);
            inputs.route.navigate([
                newThreadSubPath,
            ]);
            await touchFolder(repoPath);
            await inputs.context.folderData.refresh();
            updateState({
                searchQuery: '',
            });
        }

        /** Opening a thread counts as reading it, even when its AI chat pane isn't shown. */
        async function selectThread(thread: Readonly<Thread>) {
            void touchFolder(thread.repoPath);
            inputs.buildState.draftRepoPath.setValue(undefined);
            inputs.buildState.markedUnreadThreadId.setValue(undefined);
            buildMemory.selectedThread.write(thread.id);
            inputs.route.navigate([
                thread.id,
            ]);
            if (thread.hasUnreadReply) {
                await runAction(async () => {
                    await buildClient.call('markThreadRead', {
                        threadId: thread.id,
                    });
                });
            }
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
                const unarchived = await buildClient.call('unarchiveThread', {
                    threadId: thread.id,
                });
                storeThread(inputs.buildState, unarchived.thread);
                await selectThread(unarchived.thread);
            });
            updateState({
                unarchivingTitle: undefined,
            });
        }

        return html`
            <${VirBuildSidebarHeader.assign({
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
                        await startDraft(firstGroup.repo.path);
                    }
                })}
                ${listen(VirBuildSidebarHeader.events.addFolderRequest, () => {
                    updateState({
                        isAddFolderModalOpen: true,
                    });
                })}
                ${listen(VirBuildSidebarHeader.events.sortingSelect, async (event) => {
                    await updateSettings({
                        sidebarSorting: event.detail,
                    });
                })}
                ${listen(VirBuildSidebarHeader.events.hideInactiveChange, async (event) => {
                    await updateSettings({
                        onlyShowRecent: event.detail,
                    });
                })}
                ${listen(VirBuildSidebarHeader.events.showArchivedChange, async (event) => {
                    if (event.detail) {
                        inputs.buildState.archivedThreads.setValue([]);
                        await loadArchivedThreads(inputs.buildState);
                    } else {
                        inputs.buildState.archivedThreads.setValue(undefined);
                    }
                })}
                ${listen(VirBuildSidebarHeader.events.settingsRequest, () => {
                    inputs.context.openSettings({
                        section: SettingsSection.General,
                    });
                })}
            ></${VirBuildSidebarHeader}>
            <div class="sidebar">
                ${loadError
                    ? html`
                          <div class="message error">
                              Can't load threads: ${loadError}
                              <button
                                  type="button"
                                  class="retry"
                                  ${listen('click', async () => {
                                      await loadThreads(inputs.buildState);
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
                        /** Counted before search filtering. */
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
                                        ${listen('click', async (event) => {
                                            /**
                                             * The menu and the whole header sit inside the
                                             * collapsible header's button, which toggles on any
                                             * click that reaches it, so only a chevron click may.
                                             */
                                            const clickedClasses = event
                                                .composedPath()
                                                .flatMap((target) => {
                                                    return target instanceof HTMLElement
                                                        ? [
                                                              ...target.classList,
                                                          ]
                                                        : [];
                                                });
                                            if (clickedClasses.includes('chevron')) {
                                                return;
                                            }
                                            event.stopPropagation();
                                            if (clickedClasses.includes('project-header')) {
                                                await startDraft(group.repo.path);
                                            }
                                        })}
                                    >
                                        <div
                                            class=${classMap({
                                                'project-header': true,
                                                drafting: isDrafting,
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
                                                async onClick() {
                                                    await startDraft(group.repo.path);
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
                                            {
                                                content: 'Remove folder',
                                                async onClick() {
                                                    /**
                                                     * A search may have filtered out some of the
                                                     * folder's threads.
                                                     */
                                                    const activeThreads = (
                                                        allGroups.find((entry) => {
                                                            return (
                                                                entry.repo.path === group.repo.path
                                                            );
                                                        })?.threads ?? group.threads
                                                    ).filter((thread) => {
                                                        return !archivedThreadIds.has(thread.id);
                                                    });
                                                    if (
                                                        !globalThis.confirm(
                                                            [
                                                                `Remove ${group.repo.name} from Agent Storm?`,
                                                                ...(activeThreads.length
                                                                    ? [
                                                                          activeThreads.length === 1
                                                                              ? 'Its thread will be stopped and archived.'
                                                                              : `Its ${activeThreads.length} threads will be stopped and archived.`,
                                                                      ]
                                                                    : []),
                                                                'Nothing is deleted from disk.',
                                                            ].join('\n\n'),
                                                        )
                                                    ) {
                                                        return;
                                                    }
                                                    await runAction(async () => {
                                                        await Promise.all(
                                                            activeThreads.map(async (thread) => {
                                                                await buildClient.call(
                                                                    'archiveThread',
                                                                    {
                                                                        threadId: thread.id,
                                                                    },
                                                                );
                                                                markThreadArchived(
                                                                    inputs.buildState,
                                                                    thread.id,
                                                                );
                                                            }),
                                                        );
                                                        await fetchApi(
                                                            removeRepoEndpoint,
                                                            HttpMethod.Post,
                                                            {
                                                                requestData: {
                                                                    folder: group.repo.path,
                                                                },
                                                            },
                                                        );
                                                        await inputs.context.folderData.refresh();
                                                        if (
                                                            activeThreads.some((thread) => {
                                                                return thread.id === activeThreadId;
                                                            })
                                                        ) {
                                                            inputs.route.navigate([]);
                                                        }
                                                    });
                                                },
                                            },
                                        ])}
                                    </${ViraMenuTrigger}>
                                    <ul>
                                        ${group.threads.map((thread) => {
                                            return html`
                                                <li data-sidebar-search-result>
                                                    <${VirBuildThreadRow.assign({
                                                        thread,
                                                        folderInfo:
                                                            inputs.context.folderData.value.folderInfo.get(
                                                                thread.cwd,
                                                            ),
                                                        isActive: thread.id === activeThreadId,
                                                        isMarkedUnread:
                                                            inputs.buildState.markedUnreadThreadId
                                                                .value === thread.id,
                                                        isArchived: archivedThreadIds.has(
                                                            thread.id,
                                                        ),
                                                        sideChats: findSideChats(thread.id),
                                                        paneThreads: findPaneThreads(thread.cwd),
                                                    })}
                                                        ${listen(
                                                            VirBuildThreadRow.events.selected,
                                                            async () => {
                                                                await selectThread(thread);
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events.unarchived,
                                                            async () => {
                                                                await unarchiveThread(thread);
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events.renamed,
                                                            async (event) => {
                                                                await runAction(async () => {
                                                                    const renamed =
                                                                        await buildClient.call(
                                                                            'renameThread',
                                                                            {
                                                                                threadId: thread.id,
                                                                                title: event.detail,
                                                                            },
                                                                        );
                                                                    storeThread(
                                                                        inputs.buildState,
                                                                        renamed.thread,
                                                                    );
                                                                });
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events
                                                                .priorityChanged,
                                                            async (event) => {
                                                                await runAction(async () => {
                                                                    const changed =
                                                                        await buildClient.call(
                                                                            'setThreadPriority',
                                                                            {
                                                                                threadId: thread.id,
                                                                                isPriority:
                                                                                    event.detail,
                                                                            },
                                                                        );
                                                                    storeThread(
                                                                        inputs.buildState,
                                                                        changed.thread,
                                                                    );
                                                                });
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events.markedUnread,
                                                            async () => {
                                                                if (thread.id === activeThreadId) {
                                                                    inputs.buildState.markedUnreadThreadId.setValue(
                                                                        thread.id,
                                                                    );
                                                                }
                                                                await runAction(async () => {
                                                                    const changed =
                                                                        await buildClient.call(
                                                                            'markThreadUnread',
                                                                            {
                                                                                threadId: thread.id,
                                                                            },
                                                                        );
                                                                    storeThread(
                                                                        inputs.buildState,
                                                                        changed.thread,
                                                                    );
                                                                });
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events.watchChanged,
                                                            async (event) => {
                                                                await runAction(async () => {
                                                                    await reviewClient.call(
                                                                        'setWatchMode',
                                                                        {
                                                                            folder: thread.cwd,
                                                                            isEnabled: event.detail,
                                                                        },
                                                                    );
                                                                });
                                                            },
                                                        )}
                                                        ${listen(
                                                            VirBuildThreadRow.events.archived,
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
                                                                    await buildClient.call(
                                                                        'archiveThread',
                                                                        {
                                                                            threadId: thread.id,
                                                                            deleteWorktree: true,
                                                                        },
                                                                    );
                                                                    markThreadArchived(
                                                                        inputs.buildState,
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
                                                    ></${VirBuildThreadRow}>
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
                                        ${listen('click', async () => {
                                            await startDraft(group.repo.path);
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
            <${VirBuildAddFolderModal.assign({
                open: state.isAddFolderModalOpen,
            })}
                ${listen(VirBuildAddFolderModal.events.close, () => {
                    updateState({
                        isAddFolderModalOpen: false,
                    });
                })}
                ${listen(VirBuildAddFolderModal.events.errorReport, (event) => {
                    updateState({
                        actionError: event.detail,
                    });
                })}
                ${listen(VirBuildAddFolderModal.events.folderAdd, async (event) => {
                    await inputs.context.folderData.refresh();
                    await startDraft(event.detail);
                })}
            ></${VirBuildAddFolderModal}>
        `;
    },
});
