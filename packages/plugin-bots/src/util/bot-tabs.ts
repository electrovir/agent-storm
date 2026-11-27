import {aiChatPaneId, toPaneGroupKey} from '@agent-storm/common';
import {addTab, type UiLayoutObservable} from '@agent-storm/core/frontend';
import {mapObjectValues} from '@augment-vir/common';
import {toBotScope} from '../bots-api.js';

/** The tab id an AI run's thread gets in its bot's pane group. */
export function toBotThreadTabId(threadId: string) {
    return `${aiChatPaneId}:${threadId}`;
}

/**
 * Adds an AI Chat tab for a bot's thread to the bot's pane group, in the background unless
 * `isShown`. False, without adding it, while the pane group has no layout yet, which it gets the
 * first time it shows.
 */
export function addBotThreadTab({
    uiLayout,
    repoPath,
    botId,
    threadId,
    isShown,
}: Readonly<{
    uiLayout: Pick<UiLayoutObservable, 'getTabLayout' | 'updateTabLayout'>;
    repoPath: string;
    botId: string;
    threadId: string;
    isShown: boolean;
}>) {
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
        update(current) {
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
