import {
    aiChatPaneId,
    type SharedTabLayout,
    SplitDirection,
    SplitEdge,
    viewerPaneId,
} from '@agent-storm/common';
import {
    addTab,
    findTabGroupId,
    listGroupIds,
    selectTab,
    splitTab,
    type TabLayout,
} from '@agent-storm/core/frontend';
import {getObjectTypedEntries, getObjectTypedValues} from '@augment-vir/common';

/** The layout holding `threadId`'s AI Chat tab, and that tab. Undefined when no layout holds it. */
export function findChatTab({
    tabLayouts,
    threadId,
}: Readonly<{
    tabLayouts: Readonly<Record<string, Readonly<SharedTabLayout>>>;
    threadId: string;
}>) {
    return getObjectTypedEntries(tabLayouts)
        .map(
            ([
                layoutKey,
                layout,
            ]) => {
                return {
                    layoutKey,
                    tabId: getObjectTypedValues(layout.tabs).find((tab) => {
                        return tab.kind === aiChatPaneId && tab.state?.threadId === threadId;
                    })?.id,
                };
            },
        )
        .find((chat): chat is {layoutKey: string; tabId: string} => !!chat.tabId);
}

/** The top group of the layout's rightmost column. Undefined while the layout has one column. */
function findRightColumnGroupId(layout: Readonly<TabLayout>) {
    const root = layout.splits[layout.rootId];
    const rightColumnId = root?.direction === SplitDirection.Row ? root.childIds.at(-1) : undefined;
    return rightColumnId
        ? listGroupIds({
              ...layout,
              rootId: rightColumnId,
          })[0]
        : undefined;
}

/**
 * Shows `path` in a Viewer tab in the layout's right column. A new column splits off to the right
 * of the chat in `chatTabId` when the layout has one column or the chat is in the right column. A
 * Viewer tab already showing `path` is shown where it is instead.
 */
export function showViewerTab(
    layout: Readonly<TabLayout>,
    {
        path,
        chatTabId,
    }: Readonly<{
        path: string;
        chatTabId: string;
    }>,
) {
    const existingTab = getObjectTypedValues(layout.tabs).find((tab) => {
        return tab.kind === viewerPaneId && tab.state?.path === path;
    });
    if (existingTab) {
        return selectTab(layout, existingTab.id);
    }
    /**
     * Every open window applies the same request to the same layout, so the tab id comes from the
     * request instead of randomness: each window saves the same tab rather than adding its own.
     */
    const pathTabId = `${viewerPaneId}:${path}`;
    const tab = {
        id: layout.tabs[pathTabId] ? `${pathTabId}:${layout.nextNodeId}` : pathTabId,
        kind: viewerPaneId,
        state: {
            path,
        },
    };
    const rightGroupId = findRightColumnGroupId(layout);
    const chatGroupId = findTabGroupId(layout, chatTabId);
    if (rightGroupId && rightGroupId !== chatGroupId) {
        return addTab(layout, {
            tab,
            groupId: rightGroupId,
        });
    }
    const besideGroupId = chatGroupId || rightGroupId || listGroupIds(layout).at(-1);
    return besideGroupId
        ? splitTab(
              addTab(layout, {
                  tab,
                  groupId: besideGroupId,
              }),
              {
                  tabId: tab.id,
                  groupId: besideGroupId,
                  edge: SplitEdge.Right,
              },
          )
        : layout;
}
