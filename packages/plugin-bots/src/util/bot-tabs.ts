import {aiChatPaneId, toPaneGroupKey} from '@agent-storm/common';
import {
    addTab,
    closeTab,
    findShownTabIdOfKind,
    findTabGroupId,
    type UiLayoutObservable,
} from '@agent-storm/core/frontend';
import {mapObjectValues, type PartialWithUndefined} from '@augment-vir/common';
import {botPaneId, toBotScope} from '../bots-api.js';

/** The tab id a bot's thread gets in its bot's pane group. */
function toBotThreadTabId(threadId: string) {
    return `${aiChatPaneId}:${threadId}`;
}

/**
 * Adds an AI Chat tab for a bot's thread beside the Bot tab in its pane group, in the background
 * unless `isShown`, and closes the tab of `replacedThreadId`. False, without adding it, while the
 * pane group has no layout yet, which it gets the first time it shows.
 */
export function addBotThreadTab({
    uiLayout,
    repoPath,
    botId,
    threadId,
    isShown,
    replacedThreadId,
}: Readonly<
    {
        uiLayout: Pick<UiLayoutObservable, 'getTabLayout' | 'updateTabLayout'>;
        repoPath: string;
        botId: string;
        threadId: string;
        isShown: boolean;
    } & PartialWithUndefined<{
        /** The bot's earlier thread, whose tab this one takes the place of. */
        replacedThreadId: string;
    }>
>) {
    const layoutKey = toPaneGroupKey({
        folder: repoPath,
        scope: toBotScope(botId),
    });
    if (!uiLayout.getTabLayout(layoutKey)) {
        return false;
    }
    const tabId = toBotThreadTabId(threadId);
    uiLayout.updateTabLayout({
        folder: layoutKey,
        update(layout) {
            const current =
                layout && replacedThreadId
                    ? closeTab(layout, toBotThreadTabId(replacedThreadId))
                    : layout;
            if (!current || (!isShown && current.tabs[tabId])) {
                return current;
            }
            const added = addTab(current, {
                tab: {
                    id: tabId,
                    kind: aiChatPaneId,
                    name: 'AI Chat',
                    state: {
                        threadId,
                    },
                },
                groupId: findTabGroupId(current, findShownTabIdOfKind(current, botPaneId) || ''),
            });
            return isShown
                ? added
                : {
                      ...added,
                      groups: mapObjectValues(added.groups, (groupId, group) => {
                          return {
                              ...group,
                              activeTabId:
                                  current.groups[groupId]?.activeTabId || group.activeTabId,
                          };
                      }),
                      activeGroupId: current.activeGroupId,
                  };
        },
    });
    return true;
}
