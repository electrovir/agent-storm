import {diffPaneId, PrStatus, reviewPaneId, SplitEdge, toPaneGroupKey} from '@agent-storm/common';
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
import {getObjectTypedEntries} from '@augment-vir/common';
import {css, html, keyed, listen, nothing} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ThreadStatus} from '../../build-v2-api.js';
import {buildV2Memory} from '../../util/build-v2-memory.js';
import {
    buildV2ActivityId,
    createBuildV2State,
    findStateThread,
    newThreadSubPath,
    startThreadSync,
} from '../../util/build-v2-state.js';
import {aiChatPane} from './ai-chat-pane.js';
import {VirAiChat} from './vir-ai-chat.element.js';
import {VirBuildV2Sidebar} from './vir-build-v2-sidebar.element.js';

/** PR statuses that wait on the viewer's own review. */
const isAwaitingViewerReview: Readonly<Record<PrStatus, boolean>> = {
    [PrStatus.None]: false,
    [PrStatus.AwaitingReview]: true,
    [PrStatus.ReviewStarted]: true,
    [PrStatus.ReReviewRequested]: true,
    [PrStatus.UnresolvedComments]: false,
    [PrStatus.ChangesRequested]: false,
    [PrStatus.Approved]: false,
    [PrStatus.OthersRequestedChanges]: false,
    [PrStatus.AwaitingOtherReviews]: false,
    [PrStatus.ChecksFailed]: false,
    [PrStatus.ReadyToMerge]: false,
    [PrStatus.Merged]: false,
    [PrStatus.Closed]: false,
};

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
export const buildV2Activity = defineActivity({
    id: buildV2ActivityId,
    label: 'Build V2',
    /** The plugin itself starts off, so its one activity shows as soon as the plugin is on. */
    isEnabledByDefault: true,
    createState: createBuildV2State,
    mobileMenuTitle: 'Threads',
    sidebar: {
        widthSetting: buildV2Memory.sidebarWidth,
        render({context, state, route}) {
            return html`
                <${VirBuildV2Sidebar.assign({
                    context,
                    route,
                    buildV2State: state,
                })}></${VirBuildV2Sidebar}>
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
         * worktree was deleted would recreate its tabs on every render.
         */
        const isCwdGone = !!thread?.cwd && !!folderInfo.size && !folderInfo.has(thread.cwd);
        const folder = thread ? (!isCwdGone && thread.cwd) || thread.repoPath : draftRepoPath || '';
        const scope = `build-v2:${threadId || newThreadSubPath}`;
        const layoutKey = toPaneGroupKey({
            folder,
            scope,
        });
        /**
         * An extra AI Chat tab in a thread's tabs is a side chat, so its thread stays out of the
         * sidebar and never retitles itself. A tab holding another sidebar thread closes, since
         * that thread would otherwise show under both entries.
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
                          !tab.state?.parentThreadId
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
            buildV2Memory.reviewTabsPrUrl.readFolder(thread.id) !== folderPr.prUrl
        ) {
            buildV2Memory.reviewTabsPrUrl.writeFolder({
                folder: thread.id,
                value: folderPr.prUrl,
            });
            context.uiLayout.updateTabLayout({
                folder: toPaneGroupKey({
                    folder,
                    scope,
                }),
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
                                scope: `build-v2:${newThreadId}`,
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
                        buildV2Memory.selectedThread.write(newThreadId);
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
                            if (buildV2Memory.selectedThread.read() === newThreadId) {
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
        const rememberedId = buildV2Memory.selectedThread.read();
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
    startWithApp({state}) {
        return startThreadSync(state);
    },
});
