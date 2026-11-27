import {aiChatPaneId, diffPaneId, viewerPaneId, type PaneTab} from '@agent-storm/common';
import {createTabLayout, listGroupIds, type TabLayout} from '@agent-storm/core/frontend';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {findChatTab, showViewerTab} from './viewer-placement.js';

const chatTab: PaneTab = {
    id: 'chat',
    kind: aiChatPaneId,
    state: {
        threadId: 'thread1',
    },
};

const diffTab: PaneTab = {
    id: 'diff',
    kind: diffPaneId,
};

const path = '/repos/example/report.html';

function listColumns(layout: Readonly<TabLayout>) {
    return listGroupIds(layout).map((groupId) => layout.groups[groupId]?.tabIds);
}

function showReport(layout: Readonly<TabLayout>) {
    return showViewerTab(layout, {
        path,
        chatTabId: chatTab.id,
    });
}

describe(showViewerTab.name, () => {
    it('splits a right column off a one-column layout and shows the file there', () => {
        const shown = showReport(
            createTabLayout([
                [
                    chatTab,
                    diffTab,
                ],
            ]),
        );
        assert.deepEquals(
            {
                columns: listColumns(shown),
                state: shown.tabs[`${viewerPaneId}:${path}`]?.state,
                activeTabId: shown.groups[shown.activeGroupId]?.activeTabId,
            },
            {
                columns: [
                    [
                        chatTab.id,
                        diffTab.id,
                    ],
                    [
                        `${viewerPaneId}:${path}`,
                    ],
                ],
                state: {
                    path,
                },
                activeTabId: `${viewerPaneId}:${path}`,
            },
        );
    });

    it('adds a tab to the right column when the chat is elsewhere', () => {
        assert.deepEquals(
            listColumns(
                showReport(
                    createTabLayout([
                        [
                            chatTab,
                        ],
                        [
                            diffTab,
                        ],
                    ]),
                ),
            ),
            [
                [
                    chatTab.id,
                ],
                [
                    diffTab.id,
                    `${viewerPaneId}:${path}`,
                ],
            ],
        );
    });

    it('adds a column rather than covering a chat in the right column', () => {
        assert.deepEquals(
            listColumns(
                showReport(
                    createTabLayout([
                        [
                            diffTab,
                        ],
                        [
                            chatTab,
                        ],
                    ]),
                ),
            ),
            [
                [
                    diffTab.id,
                ],
                [
                    chatTab.id,
                ],
                [
                    `${viewerPaneId}:${path}`,
                ],
            ],
        );
    });

    it('shows a tab already showing the file instead of adding one', () => {
        const once = showReport(
            createTabLayout([
                [
                    chatTab,
                ],
                [
                    diffTab,
                ],
            ]),
        );
        const twice = showReport({
            ...once,
            groups: {
                ...once.groups,
                n1: {
                    tabIds: once.groups.n1?.tabIds || [],
                    activeTabId: diffTab.id,
                },
            },
        });
        assert.deepEquals(
            {
                columns: listColumns(twice),
                activeTabId: twice.groups.n1?.activeTabId,
            },
            {
                columns: listColumns(once),
                activeTabId: `${viewerPaneId}:${path}`,
            },
        );
    });
});

describe(findChatTab.name, () => {
    it("finds the layout holding the thread's chat", () => {
        assert.deepEquals(
            findChatTab({
                tabLayouts: {
                    other: createTabLayout([
                        [
                            diffTab,
                        ],
                    ]),
                    mine: createTabLayout([
                        [
                            chatTab,
                        ],
                    ]),
                },
                threadId: 'thread1',
            }),
            {
                layoutKey: 'mine',
                tabId: chatTab.id,
            },
        );
    });
});
