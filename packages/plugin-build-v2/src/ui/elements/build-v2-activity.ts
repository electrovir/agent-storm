import {toPaneGroupKey} from '@agent-storm/common';
import {defineActivity, updateTabState, VirPaneGroup} from '@agent-storm/core/frontend';
import {getObjectTypedEntries} from '@augment-vir/common';
import {css, html, keyed, listen, nothing} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ThreadStatus} from '../../build-v2-api.js';
import {buildV2Memory} from '../../util/build-v2-memory.js';
import {
    buildV2ActivityId,
    createBuildV2State,
    newThreadSubPath,
    startThreadSync,
} from '../../util/build-v2-state.js';
import {aiChatPane} from './ai-chat-pane.js';
import {VirAiChat} from './vir-ai-chat.element.js';
import {VirBuildV2Sidebar} from './vir-build-v2-sidebar.element.js';

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

        const thread = state.threads.value?.find((existing) => existing.id === threadId);

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

        return keyed(
            `${scope}:${folder}`,
            html`
                <${VirPaneGroup.assign({
                    folder,
                    active: true,
                    context,
                    scope,
                    defaultTabs: [
                        {
                            kind: aiChatPane.id,
                            state: {
                                threadId: threadId || '',
                            },
                        },
                    ],
                })}
                    ${listen(VirAiChat.events.threadCreated, async (event) => {
                        if (threadId) {
                            return;
                        }
                        const newThreadId = event.detail.thread.id;
                        /**
                         * The AI Chat tab has already stored the new thread in its own state, so
                         * the draft's next thread would open on this one without clearing it.
                         */
                        context.uiLayout.updateTabLayout({
                            folder: toPaneGroupKey({
                                folder,
                                scope,
                            }),
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
        return state.threads.value?.find((thread) => thread.id === threadId)?.title;
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
            !state.threads.value.some((thread) => thread.id === firstSubPath);
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
