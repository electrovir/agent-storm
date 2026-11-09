import {
    PaneKind,
    SplitDirection,
    SplitEdge,
    type FolderSessions,
    type PaneState,
    type PaneTab,
    type SharedTabLayout,
    type TabSelection,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    clamp,
    getObjectTypedKeys,
    getObjectTypedValues,
    mapObjectValues,
    omitObjectKeys,
    randomString,
    typedObjectFromEntries,
    type PartialWithUndefined,
} from '@augment-vir/common';

/** A folder's shared layout joined with this window's {@link TabSelection}. */
export type TabLayout = Omit<SharedTabLayout, 'groups'> & {
    groups: Record<
        string,
        SharedTabLayout['groups'][string] & {
            /** Empty only while the group has no tabs, which only the root group ever does. */
            activeTabId: string;
        }
    >;
    activeGroupId: string;
};

const splitEdgePlacements: Readonly<
    Record<
        SplitEdge,
        Readonly<{
            direction: SplitDirection;
            isAfter: boolean;
        }>
    >
> = {
    [SplitEdge.Left]: {
        direction: SplitDirection.Row,
        isAfter: false,
    },
    [SplitEdge.Right]: {
        direction: SplitDirection.Row,
        isAfter: true,
    },
    [SplitEdge.Top]: {
        direction: SplitDirection.Column,
        isAfter: false,
    },
    [SplitEdge.Bottom]: {
        direction: SplitDirection.Column,
        isAfter: true,
    },
};

/** The Diff pane's id. Manual review opens it, and every folder's first layout holds one. */
export const diffPaneId = 'diff';
/** The Review pane's id. Every folder's first layout holds one. */
export const reviewPaneId = 'review';

/**
 * The session kind of a tab kind whose tabs are terminal sessions. Those panes' ids are the
 * `PaneKind` values.
 */
export function findSessionPaneKind(tabKind: string) {
    return check.isEnumValue(tabKind, PaneKind) ? tabKind : undefined;
}

export function toSessionTabId({
    kind,
    sessionId,
}: Readonly<{
    kind: PaneKind;
    sessionId: string;
}>) {
    return `${kind}:${sessionId}`;
}

/** An id for a new tab that isn't a terminal session, unique among any number of its kind. */
export function createTabId(kind: string) {
    return `${kind}:${randomString(8)}`;
}

/** Undefined for a tab that isn't a terminal session. */
export function extractSessionId(tab: Readonly<PaneTab>) {
    return findSessionPaneKind(tab.kind) ? tab.id.slice(tab.kind.length + 1) : undefined;
}

/**
 * Group ids under `nodeId`, in reading order. Recursive, so its return type can't be inferred.
 * `depth` stops a stored layout whose splits loop back on themselves from recursing forever.
 */
function collectGroupIds(
    layout: Readonly<SharedTabLayout>,
    nodeId: string,
    depth: number,
): string[] {
    const split = layout.splits[nodeId];
    if (!split) {
        return layout.groups[nodeId]
            ? [
                  nodeId,
              ]
            : [];
    }
    return depth > getObjectTypedKeys(layout.splits).length
        ? []
        : split.childIds.flatMap((childId) => collectGroupIds(layout, childId, depth + 1));
}

/** Every group in the layout, in reading order. */
export function listGroupIds(layout: Readonly<SharedTabLayout>) {
    return collectGroupIds(layout, layout.rootId, 0);
}

/** Every tab in the layout, group by group. This is the order mobile's single tab strip shows. */
export function listTabIds(layout: Readonly<SharedTabLayout>) {
    return listGroupIds(layout).flatMap((groupId) => layout.groups[groupId]?.tabIds || []);
}

export function findTabGroupId(layout: Readonly<TabLayout>, tabId: string) {
    return getObjectTypedKeys(layout.groups).find((groupId) => {
        return layout.groups[groupId]?.tabIds.includes(tabId);
    });
}

/** The tab showing in the active group. */
export function findActiveTabId(layout: Readonly<TabLayout>) {
    return layout.groups[layout.activeGroupId]?.activeTabId || undefined;
}

function findParentSplitId(layout: Readonly<TabLayout>, nodeId: string) {
    return getObjectTypedKeys(layout.splits).find((splitId) => {
        return layout.splits[splitId]?.childIds.includes(nodeId);
    });
}

/** Puts `replacementId` where `nodeId` sits in the tree. */
function replaceNode(
    layout: Readonly<TabLayout>,
    {
        nodeId,
        replacementId,
    }: Readonly<{
        nodeId: string;
        replacementId: string;
    }>,
): TabLayout {
    const parentId = findParentSplitId(layout, nodeId);
    const parent = parentId && layout.splits[parentId];
    if (!parentId || !parent) {
        return {
            ...layout,
            rootId: replacementId,
        };
    }
    return {
        ...layout,
        splits: {
            ...layout.splits,
            [parentId]: {
                ...parent,
                childIds: parent.childIds.map((childId) => {
                    return childId === nodeId ? replacementId : childId;
                }),
            },
        },
    };
}

/**
 * Takes an emptied group out of the tree. Its share of the split goes to the sibling before it (or
 * after it, when it was first), and a split left with one child is replaced by that child.
 */
function removeGroup(layout: Readonly<TabLayout>, groupId: string): TabLayout {
    const parentId = findParentSplitId(layout, groupId);
    const parent = parentId && layout.splits[parentId];
    if (!parentId || !parent) {
        return layout;
    }
    const index = parent.childIds.indexOf(groupId);
    const neighborIndex = index > 0 ? index - 1 : 1;
    const neighborId = parent.childIds[neighborIndex] || '';
    const removedSize = parent.sizes[index] ?? 0;
    const childIds = parent.childIds.toSpliced(index, 1);
    const withoutGroup: TabLayout = {
        ...layout,
        groups: omitObjectKeys(layout.groups, [
            groupId,
        ]),
        splits: {
            ...layout.splits,
            [parentId]: {
                ...parent,
                childIds,
                sizes: parent.sizes
                    .map((size, sizeIndex) => {
                        return sizeIndex === neighborIndex ? size + removedSize : size;
                    })
                    .toSpliced(index, 1),
            },
        },
    };
    const collapsed: TabLayout =
        childIds.length === 1
            ? {
                  ...replaceNode(withoutGroup, {
                      nodeId: parentId,
                      replacementId: neighborId,
                  }),
                  splits: omitObjectKeys(withoutGroup.splits, [
                      parentId,
                  ]),
              }
            : withoutGroup;
    return {
        ...collapsed,
        activeGroupId:
            layout.activeGroupId === groupId
                ? collectGroupIds(collapsed, neighborId, 0)[0] || collapsed.rootId
                : layout.activeGroupId,
    };
}

/**
 * Takes a tab out of its group without forgetting the tab. The group shows the tab that slid into
 * its place, or the one before it, and closes if it's left empty, unless it's the last group.
 */
function detachTab(layout: Readonly<TabLayout>, tabId: string): TabLayout {
    const groupId = findTabGroupId(layout, tabId);
    const group = groupId && layout.groups[groupId];
    if (!groupId || !group) {
        return layout;
    }
    const index = group.tabIds.indexOf(tabId);
    const tabIds = group.tabIds.toSpliced(index, 1);
    const detached: TabLayout = {
        ...layout,
        groups: {
            ...layout.groups,
            [groupId]: {
                tabIds,
                activeTabId:
                    group.activeTabId === tabId
                        ? tabIds[Math.min(index, tabIds.length - 1)] || ''
                        : group.activeTabId,
            },
        },
    };
    return tabIds.length || groupId === layout.rootId ? detached : removeGroup(detached, groupId);
}

/** Puts `newId` beside `targetId`, in the target's split when it runs the same way. */
function insertBeside(
    layout: Readonly<TabLayout>,
    {
        targetId,
        newId,
        direction,
        isAfter,
    }: Readonly<{
        targetId: string;
        newId: string;
        direction: SplitDirection;
        isAfter: boolean;
    }>,
): TabLayout {
    const parentId = findParentSplitId(layout, targetId);
    const parent = parentId && layout.splits[parentId];
    if (parentId && parent && parent.direction === direction) {
        const index = parent.childIds.indexOf(targetId);
        const halfSize = (parent.sizes[index] ?? 0) / 2;
        const insertAt = isAfter ? index + 1 : index;
        return {
            ...layout,
            splits: {
                ...layout.splits,
                [parentId]: {
                    direction,
                    childIds: parent.childIds.toSpliced(insertAt, 0, newId),
                    sizes: parent.sizes.with(index, halfSize).toSpliced(insertAt, 0, halfSize),
                },
            },
        };
    }
    const splitId = `n${layout.nextNodeId}`;
    const replaced = replaceNode(layout, {
        nodeId: targetId,
        replacementId: splitId,
    });
    return {
        ...replaced,
        splits: {
            ...replaced.splits,
            [splitId]: {
                direction,
                childIds: isAfter
                    ? [
                          targetId,
                          newId,
                      ]
                    : [
                          newId,
                          targetId,
                      ],
                sizes: [
                    0.5,
                    0.5,
                ],
            },
        },
        nextNodeId: layout.nextNodeId + 1,
    };
}

/**
 * A layout with each non-empty list of tabs in its own group, side by side, the first tab of each
 * group showing and the first group active.
 */
export function createTabLayout(groupTabs: ReadonlyArray<ReadonlyArray<PaneTab>>): TabLayout {
    const nonEmptyGroups = groupTabs.filter((tabs) => tabs.length);
    const groups = nonEmptyGroups.length ? nonEmptyGroups : [[]];
    const groupIds = groups.map((tabs, index) => `n${index}`);
    const splitId = `n${groupIds.length}`;
    const isSplit = groupIds.length > 1;
    return {
        tabs: typedObjectFromEntries(
            groups.flat().map((tab) => {
                return [
                    tab.id,
                    {
                        ...tab,
                    },
                ];
            }),
        ),
        groups: typedObjectFromEntries(
            groups.map((tabs, index) => {
                return [
                    `n${index}`,
                    {
                        tabIds: tabs.map((tab) => tab.id),
                        activeTabId: tabs[0]?.id || '',
                    },
                ];
            }),
        ),
        splits: isSplit
            ? {
                  [splitId]: {
                      direction: SplitDirection.Row,
                      childIds: groupIds,
                      sizes: groupIds.map(() => 1 / groupIds.length),
                  },
              }
            : {},
        rootId: isSplit ? splitId : 'n0',
        activeGroupId: 'n0',
        nextNodeId: groupIds.length + 1,
    };
}

function listSessionTabs(sessions: Readonly<FolderSessions>, kind: PaneKind) {
    return sessions[kind].map((session): PaneTab => {
        return {
            id: toSessionTabId({
                kind,
                sessionId: session.id,
            }),
            kind,
        };
    });
}

/**
 * A folder's first layout: AI sessions beside shells, with the Diff and Review tabs placed where
 * that kind of folder reaches for them.
 */
export function createDefaultTabLayout({
    sessions,
    isReviewFolder,
}: Readonly<{
    sessions: Readonly<FolderSessions>;
    isReviewFolder: boolean;
}>) {
    const diffTab: PaneTab = {
        id: diffPaneId,
        kind: diffPaneId,
    };
    const reviewTab: PaneTab = {
        id: reviewPaneId,
        kind: reviewPaneId,
    };
    return createTabLayout(
        isReviewFolder
            ? [
                  listSessionTabs(sessions, PaneKind.Ai),
                  [
                      reviewTab,
                      ...listSessionTabs(sessions, PaneKind.Shell),
                      diffTab,
                  ],
              ]
            : [
                  [
                      ...listSessionTabs(sessions, PaneKind.Ai),
                      diffTab,
                  ],
                  [
                      ...listSessionTabs(sessions, PaneKind.Shell),
                      reviewTab,
                  ],
              ],
    );
}

/** Shows `tabId` in its group and makes that group active. */
export function selectTab(layout: Readonly<TabLayout>, tabId: string): TabLayout {
    const groupId = findTabGroupId(layout, tabId);
    const group = groupId && layout.groups[groupId];
    if (!groupId || !group) {
        return layout;
    }
    return {
        ...layout,
        activeGroupId: groupId,
        groups: {
            ...layout.groups,
            [groupId]: {
                ...group,
                activeTabId: tabId,
            },
        },
    };
}

/**
 * Adds `tab` to `groupId` (the active group by default) at `index` (the end by default) and shows
 * it. A tab already in the layout is shown where it is instead.
 */
export function addTab(
    layout: Readonly<TabLayout>,
    {
        tab,
        groupId,
        index,
        isBackground,
    }: Readonly<
        {
            tab: Readonly<PaneTab>;
        } & PartialWithUndefined<{
            groupId: string;
            index: number;
            /** Adds the tab without showing it, unless its group has nothing else to show. */
            isBackground: boolean;
        }>
    >,
): TabLayout {
    if (layout.tabs[tab.id]) {
        return isBackground ? layout : selectTab(layout, tab.id);
    }
    const targetGroupId = [
        groupId,
        layout.activeGroupId,
        ...listGroupIds(layout),
    ].find((id) => id != undefined && !!layout.groups[id]);
    const group = targetGroupId && layout.groups[targetGroupId];
    if (!targetGroupId || !group) {
        return layout;
    }
    const isShown = !isBackground || !group.activeTabId;
    return {
        ...layout,
        tabs: {
            ...layout.tabs,
            [tab.id]: {
                ...tab,
            },
        },
        groups: {
            ...layout.groups,
            [targetGroupId]: {
                tabIds: group.tabIds.toSpliced(index ?? group.tabIds.length, 0, tab.id),
                activeTabId: isShown ? tab.id : group.activeTabId,
            },
        },
        activeGroupId: isBackground ? layout.activeGroupId : targetGroupId,
    };
}

/** An empty `name` removes the tab's name. Does nothing for a tab that isn't in the layout. */
export function renameTab(
    layout: Readonly<TabLayout>,
    {
        tabId,
        name,
    }: Readonly<{
        tabId: string;
        name: string;
    }>,
): TabLayout {
    const tab = layout.tabs[tabId];
    if (!tab) {
        return layout;
    }
    return {
        ...layout,
        tabs: {
            ...layout.tabs,
            [tabId]: {
                ...tab,
                name: name || undefined,
            },
        },
    };
}

/** Merges `state` into a tab's own state. Does nothing for a tab that isn't in the layout. */
export function updateTabState(
    layout: Readonly<TabLayout>,
    {
        tabId,
        state,
    }: Readonly<{
        tabId: string;
        state: Readonly<Partial<PaneState>>;
    }>,
): TabLayout {
    const tab = layout.tabs[tabId];
    if (!tab) {
        return layout;
    }
    return {
        ...layout,
        tabs: {
            ...layout.tabs,
            [tabId]: {
                ...tab,
                state: {
                    ...tab.state,
                    ...state,
                },
            },
        },
    };
}

/** Removes a tab. A group it leaves empty closes, and its space goes to its neighbors. */
export function closeTab(layout: Readonly<TabLayout>, tabId: string): TabLayout {
    if (!layout.tabs[tabId]) {
        return layout;
    }
    return {
        ...detachTab(layout, tabId),
        tabs: omitObjectKeys(layout.tabs, [
            tabId,
        ]),
    };
}

/**
 * Moves a tab to `index` in `groupId`'s strip and shows it there: a reorder within its own group,
 * or a move to another group. `index` counts the target's tabs without the moved one.
 */
export function moveTab(
    layout: Readonly<TabLayout>,
    {
        tabId,
        groupId,
        index,
    }: Readonly<{
        tabId: string;
        groupId: string;
        index: number;
    }>,
): TabLayout {
    const sourceGroupId = findTabGroupId(layout, tabId);
    if (!sourceGroupId || !layout.groups[groupId]) {
        return layout;
    }
    /** Detaching first can't remove the target: it only ever removes the source group. */
    const detached =
        sourceGroupId === groupId
            ? {
                  ...layout,
                  groups: {
                      ...layout.groups,
                      [groupId]: {
                          tabIds: layout.groups[groupId].tabIds.filter((id) => id !== tabId),
                          activeTabId: tabId,
                      },
                  },
              }
            : detachTab(layout, tabId);
    const target = detached.groups[groupId];
    if (!target) {
        return layout;
    }
    return {
        ...detached,
        activeGroupId: groupId,
        groups: {
            ...detached.groups,
            [groupId]: {
                tabIds: target.tabIds.toSpliced(
                    clamp(index, {
                        min: 0,
                        max: target.tabIds.length,
                    }),
                    0,
                    tabId,
                ),
                activeTabId: tabId,
            },
        },
    };
}

/** Splits `groupId` on `edge` and moves the tab into the new half, which becomes active. */
export function splitTab(
    layout: Readonly<TabLayout>,
    {
        tabId,
        groupId,
        edge,
    }: Readonly<{
        tabId: string;
        groupId: string;
        edge: SplitEdge;
    }>,
): TabLayout {
    const sourceGroupId = findTabGroupId(layout, tabId);
    const target = layout.groups[groupId];
    /** Splitting a group off from itself with its only tab would leave the original empty. */
    if (!sourceGroupId || !target || (sourceGroupId === groupId && target.tabIds.length === 1)) {
        return layout;
    }
    const detached = detachTab(layout, tabId);
    const newGroupId = `n${detached.nextNodeId}`;
    return insertBeside(
        {
            ...detached,
            groups: {
                ...detached.groups,
                [newGroupId]: {
                    tabIds: [
                        tabId,
                    ],
                    activeTabId: tabId,
                },
            },
            activeGroupId: newGroupId,
            nextNodeId: detached.nextNodeId + 1,
        },
        {
            targetId: groupId,
            newId: newGroupId,
            ...splitEdgePlacements[edge],
        },
    );
}

/** Sets a split's child shares. Ignored when the count doesn't match the split's children. */
export function resizeSplit(
    layout: Readonly<TabLayout>,
    {
        splitId,
        sizes,
    }: Readonly<{
        splitId: string;
        sizes: ReadonlyArray<number>;
    }>,
): TabLayout {
    const split = layout.splits[splitId];
    const total = sizes.reduce((sum, size) => sum + size, 0);
    if (!split || sizes.length !== split.childIds.length || total <= 0) {
        return layout;
    }
    return {
        ...layout,
        splits: {
            ...layout.splits,
            [splitId]: {
                ...split,
                sizes: sizes.map((size) => size / total),
            },
        },
    };
}

function findKindGroupId(layout: Readonly<TabLayout>, kind: string) {
    return listGroupIds(layout).find((groupId) => {
        return layout.groups[groupId]?.tabIds.some((tabId) => layout.tabs[tabId]?.kind === kind);
    });
}

/**
 * Makes one session kind's tabs match the folder's sessions: tabs whose session is gone close, and
 * missing ones join the group already holding that kind's tabs (else the active group) without
 * being shown. Returns `layout` itself when nothing changed.
 */
export function syncSessionTabs(
    layout: Readonly<TabLayout>,
    {
        kind,
        sessionIds,
    }: Readonly<{
        kind: PaneKind;
        sessionIds: ReadonlyArray<string>;
    }>,
): Readonly<TabLayout> {
    const incomingIds = sessionIds.map((sessionId) => {
        return toSessionTabId({
            kind,
            sessionId,
        });
    });
    /** Found before pruning, so a session replacing the kind's last tab still lands there. */
    const kindGroupId = findKindGroupId(layout, kind);
    const pruned = getObjectTypedValues(layout.tabs)
        .filter((tab) => tab.kind === kind && !incomingIds.includes(tab.id))
        .reduce((current: Readonly<TabLayout>, tab) => closeTab(current, tab.id), layout);
    return incomingIds.reduce((current: Readonly<TabLayout>, tabId) => {
        return current.tabs[tabId]
            ? current
            : addTab(current, {
                  tab: {
                      id: tabId,
                      kind,
                  },
                  groupId: findKindGroupId(current, kind) ?? kindGroupId,
                  isBackground: true,
              });
    }, pruned);
}

/** Whether any of `tabIds` is a tab of `kind`. */
export function hasTabOfKind(
    layout: Readonly<TabLayout>,
    {
        tabIds,
        kind,
    }: Readonly<{
        tabIds: ReadonlyArray<string>;
        kind: string;
    }>,
) {
    return tabIds.some((tabId) => layout.tabs[tabId]?.kind === kind);
}

/**
 * The tab of `kind` the user is looking at: the active group's, else any group's showing one, else
 * the first of that kind.
 */
export function findShownTabIdOfKind(layout: Readonly<TabLayout>, kind: string) {
    const groupIds = listGroupIds(layout);
    return [
        layout.activeGroupId,
        ...groupIds,
    ]
        .map((groupId) => layout.groups[groupId]?.activeTabId)
        .concat(listTabIds(layout))
        .find((tabId) => tabId && layout.tabs[tabId]?.kind === kind);
}

/** The session of `kind` the user is looking at. See {@link findShownTabIdOfKind}. */
export function findShownSessionId(layout: Readonly<TabLayout>, kind: PaneKind) {
    const tab = layout.tabs[findShownTabIdOfKind(layout, kind) || ''];
    return tab && extractSessionId(tab);
}

/**
 * Shows the tab of `kind` the user is looking at (see {@link findShownTabIdOfKind}). With none, a
 * new tab joins the active group, unless the kind is a terminal session, which only a new session
 * can open.
 */
export function showTabKind(layout: Readonly<TabLayout>, kind: string): TabLayout {
    const tabId = findShownTabIdOfKind(layout, kind);
    if (tabId) {
        return selectTab(layout, tabId);
    }
    return findSessionPaneKind(kind)
        ? layout
        : addTab(layout, {
              tab: {
                  id: createTabId(kind),
                  kind,
              },
          });
}

/** The tab a group shows: its active tab, else its first available one. */
export function findDisplayedTabId(
    layout: Readonly<TabLayout>,
    {
        groupId,
        isAvailable,
    }: Readonly<{
        groupId: string;
        isAvailable: (tabId: string) => boolean;
    }>,
) {
    const group = layout.groups[groupId];
    return group && group.activeTabId && isAvailable(group.activeTabId)
        ? group.activeTabId
        : group?.tabIds.find((tabId) => isAvailable(tabId));
}

/** The tab mobile's single strip shows: the active tab, else the first available one. */
export function findMobileDisplayedTabId(
    layout: Readonly<TabLayout>,
    isAvailable: (tabId: string) => boolean,
) {
    const activeTabId = findActiveTabId(layout);
    return activeTabId && isAvailable(activeTabId)
        ? activeTabId
        : listTabIds(layout).find((tabId) => isAvailable(tabId));
}

/** Every tab that's on screen: one per group on desktop, one in total on mobile. */
export function listDisplayedTabIds({
    layout,
    isAvailable,
    isMobile,
}: Readonly<{
    layout: Readonly<TabLayout>;
    isAvailable: (tabId: string) => boolean;
    isMobile: boolean;
}>) {
    const tabIds = isMobile
        ? [
              findMobileDisplayedTabId(layout, isAvailable),
          ]
        : listGroupIds(layout).map((groupId) => {
              return findDisplayedTabId(layout, {
                  groupId,
                  isAvailable,
              });
          });
    return tabIds.filter((tabId) => tabId != undefined);
}

/**
 * Whether a stored layout is a tree the reducers can work on: every group reachable once, every tab
 * in exactly one group, and every split with at least two sized children. A shape check alone can't
 * see any of that.
 */
export function isTabLayoutConsistent(layout: Readonly<SharedTabLayout>) {
    const groupIds = listGroupIds(layout);
    const groupedTabIds = listTabIds(layout);
    const tabIds = getObjectTypedKeys(layout.tabs);
    return (
        groupIds.length === getObjectTypedKeys(layout.groups).length &&
        new Set(groupIds).size === groupIds.length &&
        groupedTabIds.length === tabIds.length &&
        new Set(groupedTabIds).size === groupedTabIds.length &&
        groupedTabIds.every((tabId) => layout.tabs[tabId]?.id === tabId) &&
        getObjectTypedValues(layout.splits).every((split) => {
            return split.childIds.length >= 2 && split.sizes.length === split.childIds.length;
        })
    );
}

/**
 * Joins a shared layout with the first of `selections` that's valid for each group, so a selection
 * whose tab or group another window closed falls back to the next one. Past the last, each group
 * shows its first tab and the first group is active.
 */
export function joinTabLayout(
    shared: Readonly<SharedTabLayout>,
    selections: ReadonlyArray<Readonly<TabSelection> | undefined>,
): TabLayout {
    const groupIds = listGroupIds(shared);
    return {
        ...shared,
        groups: mapObjectValues(shared.groups, (groupId, group) => {
            return {
                ...group,
                activeTabId:
                    selections
                        .map((selection) => selection?.activeTabIdByGroup[groupId])
                        .find((tabId) => tabId != undefined && group.tabIds.includes(tabId)) ||
                    group.tabIds[0] ||
                    '',
            };
        }),
        activeGroupId:
            selections
                .map((selection) => selection?.activeGroupId)
                .find((groupId) => groupId != undefined && groupIds.includes(groupId)) ||
            groupIds[0] ||
            shared.rootId,
    };
}

/** The reverse of {@link joinTabLayout}. */
export function splitTabLayout(layout: Readonly<TabLayout>) {
    const shared: SharedTabLayout = {
        ...omitObjectKeys(layout, [
            'activeGroupId',
        ]),
        groups: mapObjectValues(layout.groups, (groupId, group) => {
            return {
                tabIds: group.tabIds,
            };
        }),
    };
    const selection: TabSelection = {
        activeGroupId: layout.activeGroupId,
        activeTabIdByGroup: mapObjectValues(layout.groups, (groupId, group) => group.activeTabId),
    };
    return {
        shared,
        selection,
    };
}
