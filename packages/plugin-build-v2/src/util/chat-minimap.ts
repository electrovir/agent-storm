import {ThreadItemKind, type ThreadItem} from '../build-v2-api.js';
import {splitMessageAttachments} from './message-attachments.js';

/** The hover preview shows a few lines, so longer text is cut before it is parsed. */
const maxPreviewSourceLength = 1500;

/** One user message on a chat's minimap. */
export type MinimapTurn = {
    /** The user message's item id. */
    id: string;
    /** Markdown, without the message's attachment paths. Empty for an attachments-only message. */
    userText: string;
    /** Markdown of the last assistant message the user message got. Empty before there is one. */
    replyText: string;
};

/** A minimap entry for each user message in `items`, in timeline order. */
export function buildMinimapTurns(items: ReadonlyArray<Readonly<ThreadItem>>) {
    const userIndexes = items.flatMap((item, index) => {
        return item.kind === ThreadItemKind.UserMessage ? [index] : [];
    });

    return userIndexes.map((itemIndex, turnIndex) => {
        const reply = items
            .slice(itemIndex + 1, userIndexes[turnIndex + 1])
            .findLast(
                (item) => item.kind === ThreadItemKind.AssistantMessage && !!item.text.trim(),
            );
        const userItem = items[itemIndex];

        return {
            id: userItem?.id || '',
            userText: splitMessageAttachments(userItem?.text || '')
                .text.trim()
                .slice(0, maxPreviewSourceLength),
            replyText: reply?.text.trim().slice(0, maxPreviewSourceLength) || '',
        };
    });
}
