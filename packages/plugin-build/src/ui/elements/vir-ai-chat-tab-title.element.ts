import {defineAppElement} from '@agent-storm/core/frontend';
import {type Observable} from 'element-vir';
import {aiChatTabLabel, isTabName, type Thread} from '../../build-api.js';

/** A side chat's tab label: its thread's title, unless that title is too long for a tab. */
export const VirAiChatTabTitle = defineAppElement<{
    sideChats: Readonly<Observable<ReadonlyArray<Readonly<Thread>>>>;
    threadId: string;
}>()({
    tagName: 'vir-ai-chat-tab-title',
    render({inputs}) {
        const title =
            inputs.sideChats.value.find((thread) => thread.id === inputs.threadId)?.title || '';
        return isTabName(title) ? title : aiChatTabLabel;
    },
});
