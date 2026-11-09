import {DiffView, PaneKind, SplitDirection, SplitEdge} from '@agent-storm/common';
import {assert, assertWrap} from '@augment-vir/assert';
import {
    getObjectTypedKeys,
    getObjectTypedValues,
    mapObjectValues,
    selectFrom,
} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {DefaultTabPosition, type PaneGroupView} from './plugin-api.js';
import {
    addTab,
    closeTab,
    createDefaultTabLayout,
    createTabLayout,
    findActiveTabId,
    findShownSessionId,
    findTabGroupId,
    isTabLayoutConsistent,
    joinTabLayout,
    listDisplayedTabIds,
    listGroupIds,
    listTabIds,
    moveTab,
    renameTab,
    resizeSplit,
    selectTab,
    showTabKind,
    splitTab,
    splitTabLayout,
    syncSessionTabs,
    updateTabState,
    type TabLayout,
} from './tab-layout.js';

function createTab(id: string) {
    return {
        id,
        kind: PaneKind.Ai,
    };
}

/** Two groups side by side: `[a, b]` and `[c]`. */
function createTwoGroups() {
    return createTabLayout([
        [
            createTab('a'),
            createTab('b'),
        ],
        [
            createTab('c'),
        ],
    ]);
}

function listGroupTabs(layout: Readonly<TabLayout>) {
    return listGroupIds(layout).map((groupId) => layout.groups[groupId]?.tabIds);
}

function createSession(id: string) {
    return {
        id,
        name: '',
        aiId: '',
        conversationId: '',
        isNewConversation: false,
    };
}

const firstPaneId = 'first-pane';
const secondPaneId = 'second-pane';

/** Panes that put a tab at the end of a group, or at its start when `isStartPlaced` is passed. */
const testPanes = [
    {
        id: firstPaneId,
        defaultPlacement({extensionInputs}: Readonly<Pick<PaneGroupView, 'extensionInputs'>>) {
            return {
                group: PaneKind.Ai,
                position: extensionInputs.isStartPlaced
                    ? DefaultTabPosition.Start
                    : DefaultTabPosition.End,
            };
        },
    },
    {
        id: secondPaneId,
        defaultPlacement({extensionInputs}: Readonly<Pick<PaneGroupView, 'extensionInputs'>>) {
            return {
                group: PaneKind.Shell,
                position: extensionInputs.isStartPlaced
                    ? DefaultTabPosition.Start
                    : DefaultTabPosition.End,
            };
        },
    },
    {
        id: 'unplaced-pane',
    },
];

/** A folder with two AI sessions and one shell. */
function createFolderLayout(isStartPlaced = false) {
    return createDefaultTabLayout({
        sessions: {
            [PaneKind.Ai]: [
                createSession('ai1'),
                createSession('ai2'),
            ],
            [PaneKind.Shell]: [
                createSession('sh1'),
            ],
        },
        panes: testPanes,
        extensionInputs: {
            isStartPlaced,
        },
    });
}

describe(createTabLayout.name, () => {
    it('puts each tab list in its own group under a row split', () => {
        const layout = createTwoGroups();
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                activeTabId: findActiveTabId(layout),
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [
                        'a',
                        'b',
                    ],
                    [
                        'c',
                    ],
                ],
                activeTabId: 'a',
                isConsistent: true,
            },
        );
    });
    it('makes one empty root group when there are no tabs', () => {
        const layout = createTabLayout([]);
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                splitCount: getObjectTypedKeys(layout.splits).length,
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [],
                ],
                splitCount: 0,
                isConsistent: true,
            },
        );
    });
});

describe(createDefaultTabLayout.name, () => {
    it('puts each session kind in its own group, with placed tabs at the ends', () => {
        assert.deepEquals(listGroupTabs(createFolderLayout()), [
            [
                'ai:ai1',
                'ai:ai2',
                firstPaneId,
            ],
            [
                'shell:sh1',
                secondPaneId,
            ],
        ]);
    });
    it('puts placed tabs at the start when their placement says so', () => {
        assert.deepEquals(listGroupTabs(createFolderLayout(true)), [
            [
                firstPaneId,
                'ai:ai1',
                'ai:ai2',
            ],
            [
                secondPaneId,
                'shell:sh1',
            ],
        ]);
    });
});

describe(addTab.name, () => {
    it('adds to the active group and shows the tab', () => {
        const layout = addTab(createTwoGroups(), {
            tab: createTab('d'),
            index: 1,
        });
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                activeTabId: findActiveTabId(layout),
            },
            {
                groupTabs: [
                    [
                        'a',
                        'd',
                        'b',
                    ],
                    [
                        'c',
                    ],
                ],
                activeTabId: 'd',
            },
        );
    });
    it('only selects a tab that is already in the layout', () => {
        const layout = addTab(createTwoGroups(), {
            tab: createTab('c'),
        });
        assert.deepEquals(
            {
                tabCount: listTabIds(layout).length,
                activeTabId: findActiveTabId(layout),
            },
            {
                tabCount: 3,
                activeTabId: 'c',
            },
        );
    });
});

describe(closeTab.name, () => {
    it('shows the next tab in the group', () => {
        const layout = closeTab(selectTab(createTwoGroups(), 'a'), 'a');
        assert.strictEquals(findActiveTabId(layout), 'b');
    });
    it('removes an emptied group and collapses its split', () => {
        const layout = closeTab(selectTab(createTwoGroups(), 'c'), 'c');
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                splitCount: getObjectTypedKeys(layout.splits).length,
                activeTabId: findActiveTabId(layout),
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [
                        'a',
                        'b',
                    ],
                ],
                splitCount: 0,
                activeTabId: 'a',
                isConsistent: true,
            },
        );
    });
});

describe(moveTab.name, () => {
    it('reorders within a group', () => {
        const layout = moveTab(createTwoGroups(), {
            tabId: 'a',
            groupId: assertWrap.isDefined(findTabGroupId(createTwoGroups(), 'a')),
            index: 1,
        });
        assert.deepEquals(listGroupTabs(layout), [
            [
                'b',
                'a',
            ],
            [
                'c',
            ],
        ]);
    });
    it('moves to another group and closes the emptied source', () => {
        const start = createTwoGroups();
        const layout = moveTab(start, {
            tabId: 'c',
            groupId: start.activeGroupId,
            index: 0,
        });
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                activeTabId: findActiveTabId(layout),
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [
                        'c',
                        'a',
                        'b',
                    ],
                ],
                activeTabId: 'c',
                isConsistent: true,
            },
        );
    });
});

describe(splitTab.name, () => {
    it('adds a group beside the target in a split running the same way', () => {
        const start = createTwoGroups();
        const layout = splitTab(start, {
            tabId: 'b',
            groupId: start.activeGroupId,
            edge: SplitEdge.Right,
        });
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                sizes: layout.splits[layout.rootId]?.sizes,
                activeTabId: findActiveTabId(layout),
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [
                        'a',
                    ],
                    [
                        'b',
                    ],
                    [
                        'c',
                    ],
                ],
                sizes: [
                    0.25,
                    0.25,
                    0.5,
                ],
                activeTabId: 'b',
                isConsistent: true,
            },
        );
    });
    it('nests a split running the other way', () => {
        const start = createTwoGroups();
        const layout = splitTab(start, {
            tabId: 'a',
            groupId: assertWrap.isDefined(findTabGroupId(start, 'c')),
            edge: SplitEdge.Top,
        });
        const nested = getObjectTypedValues(layout.splits).find((split) => {
            return split.direction === SplitDirection.Column;
        });
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                nested:
                    nested &&
                    selectFrom(nested, {
                        sizes: true,
                    }),
                isConsistent: isTabLayoutConsistent(layout),
            },
            {
                groupTabs: [
                    [
                        'b',
                    ],
                    [
                        'a',
                    ],
                    [
                        'c',
                    ],
                ],
                nested: {
                    sizes: [
                        0.5,
                        0.5,
                    ],
                },
                isConsistent: true,
            },
        );
    });
    it("ignores splitting a group's only tab off itself", () => {
        const start = createTwoGroups();
        const groupId = assertWrap.isDefined(findTabGroupId(start, 'c'));
        assert.strictEquals(
            splitTab(start, {
                tabId: 'c',
                groupId,
                edge: SplitEdge.Bottom,
            }),
            start,
        );
    });
});

describe(resizeSplit.name, () => {
    it('normalizes sizes', () => {
        const start = createTwoGroups();
        const layout = resizeSplit(start, {
            splitId: start.rootId,
            sizes: [
                3,
                1,
            ],
        });
        assert.deepEquals(
            layout.splits[start.rootId]?.sizes,
            [
                0.75,
                0.25,
            ],
        );
    });
});

describe(syncSessionTabs.name, () => {
    it('returns the same layout when nothing changed', () => {
        const start = createFolderLayout();
        assert.strictEquals(
            syncSessionTabs(start, {
                kind: PaneKind.Ai,
                sessionIds: [
                    'ai1',
                    'ai2',
                ],
            }),
            start,
        );
    });
    it("closes gone sessions and adds new ones beside that kind's tabs", () => {
        const layout = syncSessionTabs(createFolderLayout(), {
            kind: PaneKind.Shell,
            sessionIds: [
                'sh2',
            ],
        });
        assert.deepEquals(
            {
                groupTabs: listGroupTabs(layout),
                activeTabId: findActiveTabId(layout),
            },
            {
                groupTabs: [
                    [
                        'ai:ai1',
                        'ai:ai2',
                        firstPaneId,
                    ],
                    [
                        secondPaneId,
                        'shell:sh2',
                    ],
                ],
                activeTabId: 'ai:ai1',
            },
        );
    });
});

describe(showTabKind.name, () => {
    it('shows the session the user last looked at, and adds a missing tab of a kind', () => {
        const start = closeTab(selectTab(createFolderLayout(), 'ai:ai2'), firstPaneId);
        const shownShell = showTabKind(start, PaneKind.Shell);
        const shownDiff = showTabKind(shownShell, firstPaneId);
        const diffTabId = assertWrap.isDefined(findActiveTabId(shownDiff));
        assert.deepEquals(
            {
                shownAi: findShownSessionId(shownShell, PaneKind.Ai),
                shellActive: findActiveTabId(shownShell),
                diffKind: shownDiff.tabs[diffTabId]?.kind,
                diffGroupTabs: listGroupTabs(shownDiff),
                diffAfterReturning: findActiveTabId(
                    showTabKind(showTabKind(shownDiff, PaneKind.Shell), firstPaneId),
                ),
            },
            {
                shownAi: 'ai2',
                shellActive: 'shell:sh1',
                diffKind: firstPaneId,
                diffAfterReturning: diffTabId,
                diffGroupTabs: [
                    [
                        'ai:ai1',
                        'ai:ai2',
                    ],
                    [
                        'shell:sh1',
                        secondPaneId,
                        diffTabId,
                    ],
                ],
            },
        );
    });
});

describe(listDisplayedTabIds.name, () => {
    it('falls back to the first available tab per group, or across groups on mobile', () => {
        const layout = selectTab(createFolderLayout(), 'shell:sh1');
        function isAvailable(tabId: string) {
            return tabId !== 'shell:sh1';
        }
        assert.deepEquals(
            [
                listDisplayedTabIds({
                    layout,
                    isAvailable,
                    isMobile: false,
                }),
                listDisplayedTabIds({
                    layout,
                    isAvailable,
                    isMobile: true,
                }),
            ],
            [
                [
                    'ai:ai1',
                    secondPaneId,
                ],
                [
                    'ai:ai1',
                ],
            ],
        );
    });
});

describe(isTabLayoutConsistent.name, () => {
    it('rejects a tab listed in two groups', () => {
        const start = createTwoGroups();
        const secondGroupId = assertWrap.isDefined(listGroupIds(start)[1]);
        assert.isFalse(
            isTabLayoutConsistent({
                ...start,
                groups: {
                    ...start.groups,
                    [secondGroupId]: {
                        tabIds: [
                            'c',
                            'a',
                        ],
                    },
                },
            }),
        );
    });
});

describe(joinTabLayout.name, () => {
    it('restores the selection that was split off', () => {
        const start = selectTab(createTwoGroups(), 'b');
        const {shared, selection} = splitTabLayout(start);
        assert.deepEquals(
            joinTabLayout(shared, [
                selection,
            ]),
            start,
        );
    });

    it('falls back when the selected tab and group are gone', () => {
        const start = selectTab(createTwoGroups(), 'c');
        const {selection} = splitTabLayout(start);
        const {shared} = splitTabLayout(closeTab(start, 'c'));
        const joined = joinTabLayout(shared, [
            selection,
        ]);
        assert.deepEquals(
            {
                activeGroupId: joined.activeGroupId,
                activeTabId: findActiveTabId(joined),
            },
            {
                activeGroupId: assertWrap.isDefined(listGroupIds(shared)[0]),
                activeTabId: 'a',
            },
        );
    });

    it('falls back to the next selection that is still valid', () => {
        const {shared, selection} = splitTabLayout(selectTab(createTwoGroups(), 'b'));
        const stale = {
            ...selection,
            activeTabIdByGroup: mapObjectValues(selection.activeTabIdByGroup, () => 'closed'),
        };
        assert.strictEquals(
            findActiveTabId(
                joinTabLayout(shared, [
                    stale,
                    selection,
                ]),
            ),
            'b',
        );
    });
});

describe(updateTabState.name, () => {
    it('merges into a tab’s own state and skips a missing tab', () => {
        const start = createTwoGroups();
        const updated = updateTabState(
            updateTabState(start, {
                tabId: 'a',
                state: {
                    selectedFolder: '/repos/copy',
                },
            }),
            {
                tabId: 'a',
                state: {
                    diffView: DiffView.ManualReview,
                },
            },
        );
        assert.deepEquals(
            {
                state: updated.tabs.a?.state,
                missing: updateTabState(start, {
                    tabId: 'missing',
                    state: {
                        diffView: DiffView.Source,
                    },
                }),
            },
            {
                state: {
                    selectedFolder: '/repos/copy',
                    diffView: DiffView.ManualReview,
                },
                missing: start,
            },
        );
    });
});

describe(renameTab.name, () => {
    it('names a tab, clears the name when empty, and skips a missing tab', () => {
        const start = createTwoGroups();
        const named = renameTab(start, {
            tabId: 'a',
            name: 'Before refactor',
        });
        assert.deepEquals(
            {
                name: named.tabs.a?.name,
                cleared: renameTab(named, {
                    tabId: 'a',
                    name: '',
                }).tabs.a?.name,
                missing: renameTab(start, {
                    tabId: 'missing',
                    name: 'Unused',
                }),
            },
            {
                name: 'Before refactor',
                cleared: undefined,
                missing: start,
            },
        );
    });
});
