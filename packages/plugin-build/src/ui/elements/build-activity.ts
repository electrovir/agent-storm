import {diffPaneId, reviewPaneId, SplitEdge, toPaneGroupKey} from '@agent-storm/common';
import {
    addTab,
    closeTab,
    createTabId,
    defineActivity,
    findShownTabIdOfKind,
    findTabGroupId,
    listGroupIds,
    moveTab,
    selectTab,
    splitTab,
    updateTabState,
    VirPaneGroup,
    type TabLayout,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {getObjectTypedEntries} from '@augment-vir/common';
import {css, html, keyed, listen, nothing} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ThreadStatus, toThreadScope} from '../../build-api.js';
import {buildClient} from '../../util/build-client.js';
import {buildMemory} from '../../util/build-memory.js';
import {
    buildActivityId,
    createBuildState,
    findStateThread,
    newThreadScope,
    newThreadSubPath,
    startThreadSync,
} from '../../util/build-state.js';
import {isAwaitingViewerReview} from '../../util/thread-activity.js';
import {findChatTab, showViewerTab} from '../../util/viewer-placement.js';
import {aiChatPane} from './ai-chat-pane.js';
import {VirAiChat} from './vir-ai-chat.element.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';

/**
 * Shows the tab of `kind` in `groupId`, moving it there from another group or adding one when the
 * layout has none.
 */
function placeTabOfKind(
    layout: Readonly<TabLayout>,
    {
        kind,
        groupId,
        index,
    }: Readonly<{
        kind: string;
        groupId: string;
        index: number;
    }>,
) {
    const tabId = findShownTabIdOfKind(layout, kind);
    if (!tabId) {
        return addTab(layout, {
            tab: {
                id: createTabId(kind),
                kind,
            },
            groupId,
            index,
        });
    }
    return findTabGroupId(layout, tabId) === groupId
        ? selectTab(layout, tabId)
        : moveTab(layout, {
              tabId,
              groupId,
              index,
          });
}

/**
 * Shows the Diff tab in the leftmost group and the Review tab in the rightmost one. Review only
 * splits off into a new group when the layout has just one, so it never adds a third column.
 */
function showReviewTabs(layout: Readonly<TabLayout>) {
    const [leftGroupId] = listGroupIds(layout);
    if (!leftGroupId) {
        return layout;
    }
    const withDiff = placeTabOfKind(layout, {
        kind: diffPaneId,
        groupId: leftGroupId,
        index: 0,
    });
    const groupIds = listGroupIds(withDiff);
    const rightGroupId = groupIds.length > 1 ? groupIds.at(-1) : undefined;
    const reviewTabId = findShownTabIdOfKind(withDiff, reviewPaneId) || createTabId(reviewPaneId);
    const withReview = rightGroupId
        ? placeTabOfKind(withDiff, {
              kind: reviewPaneId,
              groupId: rightGroupId,
              index: withDiff.groups[rightGroupId]?.tabIds.length ?? 0,
          })
        : splitTab(
              addTab(withDiff, {
                  tab: {
                      id: reviewTabId,
                      kind: reviewPaneId,
                  },
                  groupId: leftGroupId,
              }),
              {
                  tabId: reviewTabId,
                  groupId: leftGroupId,
                  edge: SplitEdge.Right,
              },
          );
    const diffTabId = findShownTabIdOfKind(withReview, diffPaneId);
    return diffTabId ? selectTab(withReview, diffTabId) : withReview;
}

/**
 * Chat threads with Claude and Codex, listed by repo, one open at a time. Each thread has its own
 * tabs, starting with just its chat, and its own terminals.
 */
export const buildActivity = defineActivity({
    id: buildActivityId,
    label: 'Build',
    /** The plugin itself starts off, so its one activity shows as soon as the plugin is on. */
    isEnabledByDefault: true,
    createState: createBuildState,
    mobileMenuTitle: 'Threads',
    sidebar: {
        widthSetting: buildMemory.sidebarWidth,
        render({context, state, route}) {
            return html`
                <${VirBuildSidebar.assign({
                    context,
                    route,
                    buildState: state,
                })}></${VirBuildSidebar}>
            `;
        },
    },
    isKeptMounted: true,
    render({context, state, route}) {
        const [firstSubPath] = route.subPaths;
        const draftRepoPath = state.draftRepoPath.value;
        const threadId = firstSubPath === newThreadSubPath ? undefined : firstSubPath;

        if (!threadId && !(firstSubPath === newThreadSubPath && draftRepoPath)) {
            return html`
                <div
                    style=${css`
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        height: 100%;
                        padding: 16px;
                        box-sizing: border-box;
                        text-align: center;
                    `}
                >
                    <strong>Pick a thread to continue</strong>
                    <span
                        style=${css`
                            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                        `}
                    >
                        Select a thread, or start a new one from a project in the sidebar.
                    </span>
                </div>
            `;
        }

        const thread = threadId ? findStateThread(state, threadId) : undefined;

        if (threadId && !thread) {
            return nothing;
        }

        const folderInfo = context.folderData.value.folderInfo;
        /**
         * The server won't save a tab layout for a folder that no longer exists, so a thread whose
         * worktree was deleted would recreate its tabs on every render. A saved repo stays listed
         * after its checkout is renamed or deleted, with a `createdAtMs` of 0 because the server
         * couldn't stat it.
         */
        function isFolderGone(path: string) {
            return !!folderInfo.size && !folderInfo.get(path)?.createdAtMs;
        }
        const isCwdGone = !!thread?.cwd && isFolderGone(thread.cwd);
        const folder = thread ? (!isCwdGone && thread.cwd) || thread.repoPath : draftRepoPath || '';
        if (thread && isFolderGone(folder)) {
            return html`
                <div
                    style=${css`
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                    `}
                >
                    <span
                        style=${css`
                            padding: 4px 8px;
                            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                        `}
                    >
                        ${folder} no longer exists, so this thread has no tabs.
                    </span>
                    ${keyed(
                        thread.id,
                        html`
                            <${VirAiChat.assign({
                                context,
                                threadId: thread.id,
                                repoPath: folder,
                                isShown: true,
                            })}></${VirAiChat}>
                        `,
                    )}
                </div>
            `;
        }
        const scope = threadId ? toThreadScope(threadId) : newThreadScope;
        const layoutKey = toPaneGroupKey({
            folder,
            scope,
        });
        /**
         * An extra AI Chat tab in a thread's tabs is a side chat, so its thread stays out of the
         * sidebar and never retitles itself. A tab holding another sidebar thread closes, since
         * that thread would otherwise show under both entries. A tab holding a thread another
         * plugin started, such as a review or watch mode thread, stays.
         */
        const strayChatTabs = threadId
            ? getObjectTypedEntries(context.uiLayout.getTabLayout(layoutKey)?.tabs || {}).filter(
                  ([
                      ,
                      tab,
                  ]) => {
                      return (
                          tab.kind === aiChatPane.id &&
                          tab.state?.threadId !== threadId &&
                          !tab.state?.parentThreadId &&
                          (!check.isString(tab.state?.threadId) ||
                              !!findStateThread(state, tab.state.threadId))
                      );
                  },
              )
            : [];
        if (strayChatTabs.length) {
            context.uiLayout.updateTabLayout({
                folder: layoutKey,
                update(current) {
                    return (
                        current &&
                        strayChatTabs.reduce(
                            (
                                layout,
                                [
                                    tabId,
                                    tab,
                                ],
                            ) => {
                                return tab.state?.threadId
                                    ? closeTab(layout, tabId)
                                    : updateTabState(layout, {
                                          tabId,
                                          state: {
                                              parentThreadId: threadId,
                                          },
                                      });
                            },
                            current,
                        )
                    );
                },
            });
        }
        const folderPr = folderInfo.get(folder);
        const isReviewWanted = !!folderPr?.prUrl && isAwaitingViewerReview[folderPr.prStatus];
        /**
         * A thread usually has its layout well before its PR waits on the viewer, so `defaultTabs`
         * alone would miss it. Done once per PR so closing the tabs keeps them closed.
         */
        if (
            thread &&
            folderPr?.prUrl &&
            isReviewWanted &&
            context.uiLayout.value.layout &&
            buildMemory.reviewTabsPrUrl.readFolder(thread.id) !== folderPr.prUrl
        ) {
            buildMemory.reviewTabsPrUrl.writeFolder({
                folder: thread.id,
                value: folderPr.prUrl,
            });
            context.uiLayout.updateTabLayout({
                folder: layoutKey,
                update(current) {
                    return current && showReviewTabs(current);
                },
            });
        }
        const chatTab = {
            kind: aiChatPane.id,
            state: {
                threadId: threadId || '',
            },
        };

        return keyed(
            `${scope}:${folder}`,
            html`
                <${VirPaneGroup.assign({
                    folder,
                    active: true,
                    context,
                    scope,
                    /** A PR waiting on the viewer opens on its diff, with the Review tab beside it. */
                    defaultTabs: isReviewWanted
                        ? [
                              [
                                  {
                                      kind: diffPaneId,
                                  },
                                  chatTab,
                              ],
                              [
                                  {
                                      kind: reviewPaneId,
                                  },
                              ],
                          ]
                        : [
                              [
                                  chatTab,
                              ],
                          ],
                })}
                    ${listen(VirAiChat.events.threadCreated, async (event) => {
                        const newThreadId = event.detail.thread.id;
                        if (threadId) {
                            return;
                        }
                        const draftLayout = context.uiLayout.getTabLayout(layoutKey);
                        /**
                         * The thread keeps the draft's tabs and splits. Its AI Chat tab already
                         * points at the new thread, so this copy happens before that's cleared.
                         */
                        context.uiLayout.updateTabLayout({
                            folder: toPaneGroupKey({
                                folder: event.detail.thread.cwd || event.detail.thread.repoPath,
                                scope: toThreadScope(newThreadId),
                            }),
                            update(current) {
                                return current ? undefined : draftLayout;
                            },
                        });
                        /**
                         * The AI Chat tab has already stored the new thread in its own state, so
                         * the draft's next thread would open on this one without clearing it.
                         */
                        context.uiLayout.updateTabLayout({
                            folder: layoutKey,
                            update(current) {
                                return (
                                    current &&
                                    getObjectTypedEntries(current.tabs)
                                        .filter(
                                            ([
                                                ,
                                                tab,
                                            ]) => tab.state?.threadId === newThreadId,
                                        )
                                        .reduce(
                                            (
                                                layout,
                                                [
                                                    tabId,
                                                ],
                                            ) => {
                                                return updateTabState(layout, {
                                                    tabId,
                                                    state: {
                                                        threadId: '',
                                                    },
                                                });
                                            },
                                            current,
                                        )
                                );
                            },
                        });
                        state.draftRepoPath.setValue(undefined);
                        buildMemory.selectedThread.write(newThreadId);
                        route.navigate([
                            newThreadId,
                        ]);
                        try {
                            await event.detail.creation;
                        } catch {
                            /**
                             * Back to the composer, which has the failed message, unless the user
                             * moved on.
                             */
                            if (buildMemory.selectedThread.read() === newThreadId) {
                                state.draftRepoPath.setValue(folder);
                                route.navigate([
                                    newThreadSubPath,
                                ]);
                            }
                        }
                    })}
                ></${VirPaneGroup}>
            `,
        );
    },
    findTitle({state, subPaths}) {
        const [threadId] = subPaths;
        return threadId ? findStateThread(state, threadId)?.title : undefined;
    },
    findCount({state}) {
        return (
            state.threads.value?.filter((thread) => thread.status === ThreadStatus.NeedsApproval)
                .length || undefined
        );
    },
    findRestoredSubPaths({state}) {
        if (state.draftRepoPath.value) {
            return [
                newThreadSubPath,
            ];
        }
        const rememberedId = buildMemory.selectedThread.read();
        return rememberedId && state.threads.value?.some((thread) => thread.id === rememberedId)
            ? [
                  rememberedId,
              ]
            : undefined;
    },
    findRedirect({subPaths, state}) {
        const [firstSubPath] = subPaths;
        /** An archived thread leaves the list, so its route would otherwise ask for it and fail. */
        const isUnknownThread =
            !!firstSubPath &&
            firstSubPath !== newThreadSubPath &&
            !!state.threads.value &&
            !findStateThread(state, firstSubPath);
        return subPaths.length > 1 ||
            (firstSubPath === newThreadSubPath && !state.draftRepoPath.value) ||
            isUnknownThread
            ? []
            : undefined;
    },
    startWithApp({state, services}) {
        const stopThreadSync = startThreadSync(state);
        const removeViewerListener = buildClient.listen('showViewerFile', ({threadId, path}) => {
            const chat = findChatTab({
                tabLayouts: services.uiLayout.value.layout?.tabLayouts || {},
                threadId,
            });
            if (chat) {
                services.uiLayout.updateTabLayout({
                    folder: chat.layoutKey,
                    update(current) {
                        return (
                            current &&
                            showViewerTab(current, {
                                path,
                                chatTabId: chat.tabId,
                            })
                        );
                    },
                });
            }
        });
        return () => {
            stopThreadSync();
            void removeViewerListener();
        };
    },
});
