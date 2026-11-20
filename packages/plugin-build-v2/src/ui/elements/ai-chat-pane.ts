import {
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {html, keyed, listen} from 'element-vir';
import {defineShape} from 'object-shape-tester';
import {createSizedIcon, LucideMessageSquareIcon} from 'vira';
import {buildV2Client} from '../../util/build-v2-client.js';
import {findBuildV2State, removeThread, storeThread} from '../../util/build-v2-state.js';
import {VirAiChat} from './vir-ai-chat.element.js';

/** An AI Chat tab's own state. */
const aiChatTabStateShape = defineShape({
    /** The thread the tab shows. Empty until the tab's first message creates one. */
    threadId: '',
});

function renderAiChat(params: PaneRenderParams<typeof aiChatTabStateShape>) {
    function setTabThread(threadId: string) {
        params.writeLayout((current) => {
            return updateTabState(current, {
                tabId: params.tabId,
                state: {
                    threadId,
                } satisfies typeof aiChatTabStateShape.runtimeType,
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
    id: 'ai-chat',
    tabStateShape: aiChatTabStateShape,
    label() {
        return 'AI Chat';
    },
    newTabEntries() {
        return [
            {
                label: 'AI Chat',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideMessageSquareIcon, 14),
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
