import {
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {html, keyed, listen} from 'element-vir';
import {defineShape} from 'object-shape-tester';
import {createSizedIcon, LucideMessageSquareIcon, ViraIcon} from 'vira';
import {aiChatPaneId, aiChatTabLabel} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {
    findBuildV2State,
    newThreadScope,
    removeThread,
    storeThread,
} from '../../util/build-v2-state.js';
import {VirAiChatTabIcon} from './vir-ai-chat-tab-icon.element.js';
import {VirAiChatTabTitle} from './vir-ai-chat-tab-title.element.js';
import {VirAiChat} from './vir-ai-chat.element.js';

const aiChatIcon = createSizedIcon(LucideMessageSquareIcon, 14);

/** An AI Chat tab's own state. */
const aiChatTabStateShape = defineShape({
    /** The thread the tab shows. Empty until the tab's first message creates one. */
    threadId: '',
    /** Set on an extra tab in a thread's tabs, whose own thread stays out of the sidebar. */
    parentThreadId: '',
});

function renderAiChat(params: PaneRenderParams<typeof aiChatTabStateShape>) {
    function setTabThread(threadId: string) {
        params.writeLayout((current) => {
            return updateTabState(current, {
                tabId: params.tabId,
                state: {
                    threadId,
                } satisfies Partial<typeof aiChatTabStateShape.runtimeType>,
            });
        });
    }

    return keyed(
        params.tabState.threadId || `draft:${params.tabId}`,
        html`
            <${VirAiChat.assign({
                context: params.context,
                threadId: params.tabState.threadId || undefined,
                repoPath: params.folder,
                isShown: params.isDisplayed && params.isActive,
                parentThreadId: params.tabState.parentThreadId || undefined,
                isSidebarThread: params.scope === newThreadScope,
            })}
                ${listen(VirAiChat.events.threadCreated, async (event) => {
                    const state = findBuildV2State(params.context);
                    if (state) {
                        storeThread(state, event.detail.thread);
                    }
                    setTabThread(event.detail.thread.id);
                    try {
                        await event.detail.creation;
                    } catch {
                        /** The draft composer already put the failed message back. */
                        if (state) {
                            removeThread(state, event.detail.thread.id);
                        }
                        setTabThread('');
                    }
                })}
                ${listen(VirAiChat.events.threadArchived, () => {
                    setTabThread('');
                })}
            ></${VirAiChat}>
        `,
    );
}

/** A Build V2 chat thread in a folder's tabs, beside its terminals and diffs. */
export const aiChatPane: PaneDefinition<typeof aiChatTabStateShape> = {
    id: aiChatPaneId,
    tabStateShape: aiChatTabStateShape,
    label() {
        return aiChatTabLabel;
    },
    newTabEntries() {
        return [
            {
                label: aiChatTabLabel,
                state: undefined,
            },
        ];
    },
    icon: aiChatIcon,
    renderTabLabel({tabState, context}) {
        const state = findBuildV2State(context);
        return state && tabState.threadId && tabState.parentThreadId
            ? html`
                  <${VirAiChatTabTitle.assign({
                      sideChats: state.sideChats,
                      threadId: tabState.threadId,
                  })}></${VirAiChatTabTitle}>
              `
            : aiChatTabLabel;
    },
    renderTabIcon({tabState, context}) {
        const state = findBuildV2State(context);
        return state && tabState.threadId
            ? html`
                  <${VirAiChatTabIcon.assign({
                      threads: state.threads,
                      sideChats: state.sideChats,
                      paneThreads: state.paneThreads,
                      threadId: tabState.threadId,
                      icon: aiChatIcon,
                  })}></${VirAiChatTabIcon}>
              `
            : html`
                  <${ViraIcon.assign({
                      icon: aiChatIcon,
                  })}></${ViraIcon}>
              `;
    },
    hasAi: false,
    /** Stays mounted once shown so a running thread keeps streaming into its timeline. */
    mounting: PaneMounting.OnceDisplayed,
    isAvailable() {
        return true;
    },
    render: renderAiChat,
    menuEntries({tabState}) {
        return tabState.threadId
            ? [
                  {
                      content: 'Restart',
                      async onClick() {
                          try {
                              await buildV2Client.call('restartThread', {
                                  threadId: tabState.threadId,
                              });
                          } catch (error) {
                              window.alert(extractErrorMessage(error));
                          }
                      },
                  },
              ]
            : [];
    },
};
