import {defineNumberSetting, defineSetting, sidebarWidth} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {PrQueueKind} from './pr-queues.js';

/** The order the Review pane lists a PR's previous conversations in. */
export enum ConversationSortOrder {
    NewestFirst = 'newest-first',
    OldestFirst = 'oldest-first',
}

/** The Review tab's memory, restored whenever the tab opens with nothing selected. */
export const reviewMemory = {
    /** Same as the main sidebar's width setting, for the Review tab's sidebar. */
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:review-sidebar-width',
        bounds: sidebarWidth,
    }),
    /** `pullRequestRouteKey` of the last selected pull request. */
    selectedPullRequest: defineSetting<string | undefined>({
        key: 'agent-storm:review:selected-pull-request',
        defaultValue: undefined,
        parse(raw) {
            return raw || undefined;
        },
        serialize(value) {
            return value || undefined;
        },
    }),
    /** The sidebar list that was showing last. */
    selectedQueue: defineSetting<PrQueueKind | undefined>({
        key: 'agent-storm:review:selected-queue',
        defaultValue: undefined,
        parse(raw) {
            return check.isEnumValue(raw, PrQueueKind) ? raw : undefined;
        },
        serialize(value) {
            return value;
        },
    }),
    /** Shared by every PR's Review pane. */
    conversationSortOrder: defineSetting<ConversationSortOrder>({
        key: 'agent-storm:review:conversation-sort-order',
        defaultValue: ConversationSortOrder.NewestFirst,
        parse(raw) {
            return check.isEnumValue(raw, ConversationSortOrder)
                ? raw
                : ConversationSortOrder.NewestFirst;
        },
        serialize(value) {
            return value;
        },
    }),
};
