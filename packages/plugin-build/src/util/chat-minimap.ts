import {ThreadItemKind, type ThreadItem} from '../build-api.js';
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

function findTurnBoundary(turnCount: number, isBeforeBoundary: (index: number) => boolean) {
    let start = 0;
    let end = turnCount;
    while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if (isBeforeBoundary(middle)) {
            start = middle + 1;
        } else {
            end = middle;
        }
    }
    return start;
}

/** Entries are in vertical layout order. The last turn ends at `contentBottom`. */
export function getMinimapViewport({
    entries,
    view,
    contentBottom,
    jumpOffset,
}: Readonly<{
    entries: ReadonlyArray<
        Readonly<{
            dataset: HTMLElement['dataset'];
            getBoundingClientRect(): Pick<DOMRectReadOnly, 'top'>;
        }>
    >;
    view: Readonly<Pick<DOMRectReadOnly, 'top' | 'bottom'>>;
    contentBottom: number;
    jumpOffset: number;
}>) {
    const firstVisible = findTurnBoundary(entries.length, (index) => {
        return (entries[index + 1]?.getBoundingClientRect().top ?? contentBottom) <= view.top;
    });
    const afterVisible = findTurnBoundary(entries.length, (index) => {
        return (entries[index]?.getBoundingClientRect().top ?? contentBottom) < view.bottom;
    });
    const visibleTurns = entries.slice(firstVisible, afterVisible);
    const inViewIds = visibleTurns.map(({dataset}) => dataset.turnId || '');
    const currentIndex = visibleTurns.findIndex((_entry, index) => {
        const turnBottom =
            entries[firstVisible + index + 1]?.getBoundingClientRect().top ?? contentBottom;
        return turnBottom > view.top + jumpOffset;
    });
    return {
        inViewIds,
        currentId: inViewIds[currentIndex],
        isAtEnd: contentBottom <= view.bottom + 1,
    };
}
