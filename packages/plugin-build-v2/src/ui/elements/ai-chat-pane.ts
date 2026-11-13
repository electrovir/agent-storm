import {
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {html, keyed, listen} from 'element-vir';
import {defineShape} from 'object-shape-tester';
import {createSizedIcon, LucideMessageSquareIcon} from 'vira';
import {findBuildV2State, storeThread} from '../../util/build-v2-state.js';
import {VirAiChat} from './vir-ai-chat.element.js';

/** An AI Chat tab's own state. */
const aiChatTabStateShape = defineShape({
    /** The thread the tab shows. Empty until the tab's first message creates one. */
    threadId: '',
});

function renderAiChat(params: PaneRenderParams<typeof aiChatTabStateShape>) {
    return keyed(
        params.tabState.threadId || `draft:${params.tabId}`,
        html`
            <${VirAiChat.assign({
                context: params.context,
                threadId: params.tabState.threadId || undefined,
                repoPath: params.folder,
            })}
                ${listen(VirAiChat.events.threadCreated, (event) => {
                    const state = findBuildV2State(params.context);
                    if (state) {
                        storeThread(state, event.detail);
                    }
                    params.writeLayout((current) => {
                        return updateTabState(current, {
                            tabId: params.tabId,
                            state: {
                                threadId: event.detail.id,
                            } satisfies typeof aiChatTabStateShape.runtimeType,
                        });
                    });
                })}
            ></${VirAiChat}>
        `,
    );
}

/** A Build V2 chat thread in a folder's tabs, beside its terminals and diffs. */
export const aiChatPane: PaneDefinition<typeof aiChatTabStateShape> = {
    id: 'ai-chat',
    tabStateShape: aiChatTabStateShape,
    label({tabState, context}) {
        return (
            findBuildV2State(context)?.threads.value?.find(
                (thread) => thread.id === tabState.threadId,
            )?.title || 'AI Chat'
        );
    },
    newTabEntries({context, folder}) {
        const folderThreads = (findBuildV2State(context)?.threads.value || [])
            .filter((thread) => thread.repoPath === folder || thread.cwd === folder)
            .toSorted((first, second) => second.updatedAt - first.updatedAt);
        return [
            {
                label: 'AI Chat',
                state: undefined,
            },
            ...folderThreads.map((thread) => {
                return {
                    label: `AI Chat: ${thread.title || 'New thread'}`,
                    state: {
                        threadId: thread.id,
                    },
                };
            }),
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
};
