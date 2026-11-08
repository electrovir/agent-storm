import {SplitDirection, SplitEdge, type PaneTabKind} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {clamp, getEnumValues, type PartialWithUndefined} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {
    renderMenuItemEntries,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
    ViraTabs,
    ViraTabsBarDirection,
    ViraTabsIconLayout,
    viraTheme,
    viraThemeByKeys,
    ViraThemeColorName,
    type ViraIconSvg,
    type ViraMenuItemEntry,
    type ViraTab,
} from 'vira';
import {staticTabRouter, toStaticTabRoute} from '../../util/static-tab-router.js';
import {
    countElementsBefore,
    findElementIndexAt,
    listInlineTabElements,
    trackPointerDrag,
} from '../../util/tab-drag.js';
import {
    findDisplayedTabId,
    findMobileDisplayedTabId,
    listTabIds,
    moveTab,
    resizeSplit,
    selectTab,
    splitTab,
    type TabLayout,
} from '../../util/tab-layout.js';
import {defineAppElement} from '../define-app-element.js';
import {sidebarContextMenuOffset} from './sidebar-menu-styles.js';
import {VirResizeDivider} from './vir-resize-divider.element.js';

/** What the tab host shows for one tab of the layout. */
export type TabHostTab = {
    label: HtmlInterpolation;
    /** An unavailable tab keeps its place in the layout but leaves its strip until it's back. */
    isAvailable: boolean;
    /** The tab's right-click (or long-press) menu. */
    menuEntries: ReadonlyArray<ViraMenuItemEntry>;
} & PartialWithUndefined<{
    icon: ViraIconSvg;
}>;

export type TabHostNewTabOption = {
    label: HtmlInterpolation;
    kind: PaneTabKind;
};

type PixelRect = Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
}>;

/** Where a dragged tab would land, and the outline of that spot relative to the host. */
type DropTarget = Readonly<{
    apply: (layout: Readonly<TabLayout>) => Readonly<TabLayout>;
    preview: PixelRect;
}>;

/** How close to a group's edge, as a share of its size, a dropped tab splits the group. */
const splitEdgeShare = 0.25;

/** The smallest share of a split a resize leaves either side of its divider. */
const minSplitShare = 0.1;

const dropLineWidthPx = 2;

function isPointInRect({
    rect,
    clientX,
    clientY,
}: Readonly<{
    rect: Readonly<DOMRect>;
    clientX: number;
    clientY: number;
}>) {
    return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
    );
}

/** Which edge of `rect` a pointer at `clientX`, `clientY` is near, if any. */
function findDropEdge({
    rect,
    clientX,
    clientY,
}: Readonly<{
    rect: Readonly<DOMRect>;
    clientX: number;
    clientY: number;
}>) {
    const x = rect.width ? (clientX - rect.left) / rect.width : 0.5;
    const y = rect.height ? (clientY - rect.top) / rect.height : 0.5;
    const distances: Readonly<Record<SplitEdge, number>> = {
        [SplitEdge.Left]: x,
        [SplitEdge.Right]: 1 - x,
        [SplitEdge.Top]: y,
        [SplitEdge.Bottom]: 1 - y,
    };
    const nearest = getEnumValues(SplitEdge).reduce((closest, edge) => {
        return distances[edge] < distances[closest] ? edge : closest;
    }, SplitEdge.Left);
    return distances[nearest] < splitEdgeShare ? nearest : undefined;
}

/** The half of `rect` a tab dropped on `edge` takes over. */
function toEdgePreview(rect: PixelRect, edge: SplitEdge): PixelRect {
    const halves: Readonly<Record<SplitEdge, PixelRect>> = {
        [SplitEdge.Left]: {
            ...rect,
            width: rect.width / 2,
        },
        [SplitEdge.Right]: {
            ...rect,
            left: rect.left + rect.width / 2,
            width: rect.width / 2,
        },
        [SplitEdge.Top]: {
            ...rect,
            height: rect.height / 2,
        },
        [SplitEdge.Bottom]: {
            ...rect,
            top: rect.top + rect.height / 2,
            height: rect.height / 2,
        },
    };
    return halves[edge];
}

/**
 * A folder's tabs: groups of tabs tiled by splits, each group with its own tab strip. Tabs drag to
 * reorder, to another group's strip or body, or onto a group's edge to split it. Mobile shows every
 * tab in one strip and only one tab at a time.
 *
 * Each shown tab's content is a light-DOM child of the host with `slot="tab-<tab id>"`, so content
 * keeps its DOM (a terminal keeps its connection) when its tab moves between groups.
 */
export const VirTabHost = defineAppElement<{
    layout: Readonly<TabLayout>;
    tabs: Readonly<Record<string, Readonly<TabHostTab>>>;
    newTabOptions: ReadonlyArray<Readonly<TabHostNewTabOption>>;
    isMobile: boolean;
}>()({
    tagName: 'vir-tab-host',
    events: {
        layoutChanged: defineElementEvent<Readonly<TabLayout>>(),
        /** The tab shown in the group the user last focused, for panes that look different then. */
        focusedTabChanged: defineElementEvent<string | undefined>(),
        newTabRequested: defineElementEvent<
            Readonly<{
                kind: PaneTabKind;
                /** Undefined on mobile, which has no groups of its own. */
                groupId: string | undefined;
            }>
        >(),
    },
    state() {
        return {
            /**
             * The group last given focus. Kept here rather than saved in the layout so clicking
             * around doesn't write to the server.
             */
            focusedGroupId: undefined as string | undefined,
            /** The last tab sent in a focusedTabChanged event. */
            focusedTabId: undefined as string | undefined,
            dropTarget: undefined as DropTarget | undefined,
            /** A divider drag in progress, whose sizes show until the drag ends and stores them. */
            resizing: undefined as
                | Readonly<{
                      splitId: string;
                      index: number;
                      startSizes: ReadonlyArray<number>;
                      containerPx: number;
                      sizes: ReadonlyArray<number>;
                  }>
                | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            position: relative;
            width: 100%;
            height: 100%;
            min-height: 0;
        }

        .node {
            display: flex;
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
        }

        .split {
            flex-direction: row;

            &[data-column] {
                flex-direction: column;
            }
        }

        .group {
            flex-direction: column;
        }

        .root {
            flex-grow: 1;
        }

        .strip {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 4px;
            padding-right: 4px;
            font-size: 12px;
            border-bottom: 1px solid
                ${viraTheme.colors['vira-grey-foreground-decoration'].foreground.value};
        }

        .strip-tabs {
            flex-grow: 1;
            flex-shrink: 1;
            align-self: flex-end;
            min-width: 0;

            /** The strip draws this line instead, so it runs under the strip's buttons too. */
            & ${ViraTabs} {
                ${ViraTabs.cssVars['vira-tabs-tab-padding-inline'].name}: 8px;
                width: 100%;
                border-bottom: none;
            }
        }

        .strip-actions {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 6px;
        }

        .body {
            position: relative;
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;
        }

        .empty-message {
            padding: 16px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font-size: 12px;
        }

        .drop-preview {
            position: absolute;
            z-index: 3;
            background: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            opacity: 0.25;
            pointer-events: none;
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        const layout = inputs.layout;

        function isAvailable(tabId: string) {
            return !!host.instanceInputs.tabs[tabId]?.isAvailable;
        }

        function changeLayout(update: (current: Readonly<TabLayout>) => Readonly<TabLayout>) {
            const current = host.instanceInputs.layout;
            const updated = update(current);
            if (updated !== current) {
                dispatch(
                    new events.layoutChanged({
                        detail: updated,
                    }),
                );
            }
        }

        function toHostRect(rect: Readonly<DOMRect>): PixelRect {
            const hostRect = host.getBoundingClientRect();
            return {
                left: rect.left - hostRect.left,
                top: rect.top - hostRect.top,
                width: rect.width,
                height: rect.height,
            };
        }

        /** The tabs a strip shows, in the order `ViraTabs` lays them out. */
        function listStripTabIds(tabIds: ReadonlyArray<string>) {
            return tabIds.filter((tabId) => isAvailable(tabId));
        }

        function findStripDropTarget({
            groupId,
            stripElement,
            tabId,
            clientX,
        }: Readonly<{
            groupId: string;
            stripElement: Element;
            tabId: string;
            clientX: number;
        }>): DropTarget | undefined {
            const current = host.instanceInputs.layout;
            const group = current.groups[groupId];
            if (!group) {
                return undefined;
            }
            const stripTabIds = listStripTabIds(group.tabIds);
            const others = listInlineTabElements(stripElement.querySelector(ViraTabs.tagName))
                .map((element, index) => {
                    return {
                        element,
                        tabId: stripTabIds[index] || '',
                    };
                })
                .filter((entry) => entry.tabId && entry.tabId !== tabId);
            const remainingTabIds = group.tabIds.filter((id) => id !== tabId);
            const insertBefore = countElementsBefore({
                elements: others.map((entry) => entry.element),
                position: clientX,
                isVertical: false,
            });
            const nextEntry = others[insertBefore];
            const previousEntry = others[insertBefore - 1];
            const index = nextEntry
                ? remainingTabIds.indexOf(nextEntry.tabId)
                : previousEntry
                  ? remainingTabIds.indexOf(previousEntry.tabId) + 1
                  : remainingTabIds.length;
            if (group.tabIds.includes(tabId) && group.tabIds.indexOf(tabId) === index) {
                return undefined;
            }
            const stripRect = toHostRect(stripElement.getBoundingClientRect());
            const lineX = nextEntry
                ? toHostRect(nextEntry.element.getBoundingClientRect()).left
                : previousEntry
                  ? previousEntry.element.getBoundingClientRect().right -
                    host.getBoundingClientRect().left
                  : stripRect.left;
            return {
                apply(layoutToChange) {
                    return moveTab(layoutToChange, {
                        tabId,
                        groupId,
                        index,
                    });
                },
                preview: {
                    left: lineX - dropLineWidthPx / 2,
                    top: stripRect.top,
                    width: dropLineWidthPx,
                    height: stripRect.height,
                },
            };
        }

        function findBodyDropTarget({
            groupId,
            bodyElement,
            tabId,
            clientX,
            clientY,
        }: Readonly<{
            groupId: string;
            bodyElement: Element;
            tabId: string;
            clientX: number;
            clientY: number;
        }>): DropTarget | undefined {
            const group = host.instanceInputs.layout.groups[groupId];
            if (!group) {
                return undefined;
            }
            const rect = bodyElement.getBoundingClientRect();
            const edge = findDropEdge({
                rect,
                clientX,
                clientY,
            });
            const isOwnGroup = group.tabIds.includes(tabId);
            if (edge) {
                /** Splitting a group's only tab off itself changes nothing. */
                return isOwnGroup && group.tabIds.length === 1
                    ? undefined
                    : {
                          apply(layoutToChange) {
                              return splitTab(layoutToChange, {
                                  tabId,
                                  groupId,
                                  edge,
                              });
                          },
                          preview: toEdgePreview(toHostRect(rect), edge),
                      };
            }
            return isOwnGroup
                ? undefined
                : {
                      apply(layoutToChange) {
                          return moveTab(layoutToChange, {
                              tabId,
                              groupId,
                              index: group.tabIds.length,
                          });
                      },
                      preview: toHostRect(rect),
                  };
        }

        function findDropTarget({
            tabId,
            clientX,
            clientY,
        }: Readonly<{
            tabId: string;
            clientX: number;
            clientY: number;
        }>) {
            const groupElement = Array.from(
                host.shadowRoot.querySelectorAll('[data-group-id]'),
            ).find((element) => {
                return isPointInRect({
                    rect: element.getBoundingClientRect(),
                    clientX,
                    clientY,
                });
            });
            const groupId = groupElement?.getAttribute('data-group-id');
            const stripElement = groupElement?.querySelector('.strip');
            const bodyElement = groupElement?.querySelector('.body');
            if (!groupId || !stripElement || !bodyElement) {
                return undefined;
            }
            return isPointInRect({
                rect: stripElement.getBoundingClientRect(),
                clientX,
                clientY,
            })
                ? findStripDropTarget({
                      groupId,
                      stripElement,
                      tabId,
                      clientX,
                  })
                : findBodyDropTarget({
                      groupId,
                      bodyElement,
                      tabId,
                      clientX,
                      clientY,
                  });
        }

        /**
         * Notes which tab a press landed on, for the context menu, and starts dragging it. Tabs are
         * found by position, since `ViraTabs` doesn't put the tab on the event.
         */
        function onStripPointerDown({
            event,
            stripTabIds,
            isDraggable,
        }: Readonly<{
            event: PointerEvent;
            stripTabIds: ReadonlyArray<string>;
            isDraggable: boolean;
        }>) {
            const stripTabsElement = event.currentTarget;
            if (!check.instanceOf(stripTabsElement, HTMLElement)) {
                return;
            }
            const tabIndex = findElementIndexAt({
                elements: listInlineTabElements(stripTabsElement.querySelector(ViraTabs.tagName)),
                clientX: event.clientX,
                clientY: event.clientY,
            });
            const tabId = stripTabIds[tabIndex];
            if (!tabId || !isDraggable) {
                return;
            }
            trackPointerDrag({
                event,
                captureElement: host,
                onStart() {},
                onMove(moveEvent) {
                    updateState({
                        dropTarget: findDropTarget({
                            tabId,
                            clientX: moveEvent.clientX,
                            clientY: moveEvent.clientY,
                        }),
                    });
                },
                onEnd(endEvent) {
                    const dropTarget =
                        endEvent &&
                        findDropTarget({
                            tabId,
                            clientX: endEvent.clientX,
                            clientY: endEvent.clientY,
                        });
                    updateState({
                        dropTarget: undefined,
                    });
                    if (dropTarget) {
                        changeLayout(dropTarget.apply);
                    }
                },
            });
        }

        function renderStrip({
            tabIds,
            displayedTabId,
            groupId,
        }: Readonly<{
            tabIds: ReadonlyArray<string>;
            displayedTabId: string | undefined;
            groupId: string | undefined;
        }>) {
            const stripTabIds = listStripTabIds(tabIds);
            const viraTabs = tabIds.map((tabId): ViraTab => {
                const tab = inputs.tabs[tabId];
                return {
                    label: tab?.label,
                    icon: tab?.icon,
                    isHidden: !tab?.isAvailable,
                    contextMenuEntries: tab?.menuEntries,
                    paths: {
                        path: tabId,
                        fullPaths: [tabId],
                        PathsType: [tabId],
                    },
                };
            });
            return html`
                <div class="strip">
                    <div
                        class="strip-tabs"
                        ${listen('pointerdown', (event) => {
                            onStripPointerDown({
                                event,
                                stripTabIds,
                                isDraggable: !inputs.isMobile,
                            });
                        })}
                        ${listen('dragstart', (event) => {
                            /**
                             * Each tab is a link, and the browser's own link drag would cancel the
                             * pointer events the tab drag runs on.
                             */
                            event.preventDefault();
                        })}
                    >
                        <${ViraTabs.assign({
                            tabs: viraTabs,
                            router: staticTabRouter,
                            currentRoute: toStaticTabRoute(displayedTabId),
                            barDirection: ViraTabsBarDirection.Bottom,
                            iconLayout: ViraTabsIconLayout.Horizontal,
                            color: ViraThemeColorName.blue,
                            contextMenuPopoverOffset: sidebarContextMenuOffset,
                        })}
                            ${listen(ViraTabs.events.tabSelect, (event) => {
                                const tabId = event.detail.paths.fullPaths[0];
                                if (tabId) {
                                    changeLayout((current) => selectTab(current, tabId));
                                }
                            })}
                        ></${ViraTabs}>
                    </div>
                    <div class="strip-actions">
                        <${ViraMenuTrigger.assign({})}>
                            <${ViraButton.assign({
                                buttonSize: ViraSize.Small,
                                buttonEmphasis: ViraEmphasis.Subtle,
                                color: ViraColorVariant.Neutral,
                                text: '+',
                            })}
                                slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                                title="New tab"
                            ></${ViraButton}>
                            ${renderMenuItemEntries(
                                inputs.newTabOptions.map((option): ViraMenuItemEntry => {
                                    return {
                                        content: option.label,
                                        onClick() {
                                            dispatch(
                                                new events.newTabRequested({
                                                    detail: {
                                                        kind: option.kind,
                                                        groupId,
                                                    },
                                                }),
                                            );
                                        },
                                    };
                                }),
                            )}
                        </${ViraMenuTrigger}>
                    </div>
                </div>
            `;
        }

        function renderBody(displayedTabId: string | undefined) {
            return html`
                <div class="body">
                    ${displayedTabId
                        ? html`
                              <slot name=${`tab-${displayedTabId}`}></slot>
                          `
                        : html`
                              <div class="empty-message">No tabs open. Open one with +.</div>
                          `}
                </div>
            `;
        }

        const focusedGroupId =
            state.focusedGroupId && layout.groups[state.focusedGroupId]
                ? state.focusedGroupId
                : layout.activeGroupId;

        function renderGroup(groupId: string, flexGrow: number) {
            const group = layout.groups[groupId];
            if (!group) {
                return nothing;
            }
            const displayedTabId = findDisplayedTabId(layout, {
                groupId,
                isAvailable,
            });
            return html`
                <div
                    class="node group"
                    data-group-id=${groupId}
                    style=${css`
                        flex-grow: ${flexGrow};
                    `}
                    ${listen('focusin', () => {
                        if (host.instanceState.focusedGroupId !== groupId) {
                            updateState({
                                focusedGroupId: groupId,
                            });
                        }
                    })}
                >
                    ${renderStrip({
                        tabIds: group.tabIds,
                        displayedTabId,
                        groupId,
                    })}
                    ${renderBody(displayedTabId)}
                </div>
            `;
        }

        /** Recursive, so its return type can't be inferred. */
        function renderNode(nodeId: string, flexGrow: number): HtmlInterpolation {
            const split = layout.splits[nodeId];
            if (!split) {
                return renderGroup(nodeId, flexGrow);
            }
            const sizes = state.resizing?.splitId === nodeId ? state.resizing.sizes : split.sizes;
            const isColumn = split.direction === SplitDirection.Column;
            return html`
                <div
                    class="node split"
                    ?data-column=${isColumn}
                    style=${css`
                        flex-grow: ${flexGrow};
                    `}
                >
                    ${split.childIds.map((childId, index) => {
                        return html`
                            ${index
                                ? html`
                                      <${VirResizeDivider.assign({
                                          isHorizontal: isColumn,
                                      })}
                                          ${listen(VirResizeDivider.events.dragStarted, (event) => {
                                              const rect = extractEventTarget(
                                                  event,
                                                  HTMLElement,
                                              ).parentElement?.getBoundingClientRect();
                                              updateState({
                                                  resizing: {
                                                      splitId: nodeId,
                                                      index: index - 1,
                                                      startSizes: split.sizes,
                                                      containerPx:
                                                          (isColumn ? rect?.height : rect?.width) ||
                                                          0,
                                                      sizes: split.sizes,
                                                  },
                                              });
                                          })}
                                          ${listen(VirResizeDivider.events.dragged, (event) => {
                                              const resizing = host.instanceState.resizing;
                                              if (
                                                  resizing?.splitId !== nodeId ||
                                                  resizing.containerPx <= 0
                                              ) {
                                                  return;
                                              }
                                              const before =
                                                  resizing.startSizes[resizing.index] ?? 0;
                                              const pairTotal =
                                                  before +
                                                  (resizing.startSizes[resizing.index + 1] ?? 0);
                                              const minShare = Math.min(
                                                  minSplitShare,
                                                  pairTotal / 2,
                                              );
                                              const resized = clamp(
                                                  before +
                                                      (isColumn
                                                          ? event.detail.deltaY
                                                          : event.detail.deltaX) /
                                                          resizing.containerPx,
                                                  {
                                                      min: minShare,
                                                      max: pairTotal - minShare,
                                                  },
                                              );
                                              updateState({
                                                  resizing: {
                                                      ...resizing,
                                                      sizes: resizing.startSizes
                                                          .with(resizing.index, resized)
                                                          .with(
                                                              resizing.index + 1,
                                                              pairTotal - resized,
                                                          ),
                                                  },
                                              });
                                          })}
                                          ${listen(VirResizeDivider.events.dragEnded, () => {
                                              const resizing = host.instanceState.resizing;
                                              updateState({
                                                  resizing: undefined,
                                              });
                                              if (resizing) {
                                                  changeLayout((current) => {
                                                      return resizeSplit(current, {
                                                          splitId: nodeId,
                                                          sizes: resizing.sizes,
                                                      });
                                                  });
                                              }
                                          })}
                                          ${listen(VirResizeDivider.events.resetRequested, () => {
                                              changeLayout((current) => {
                                                  return resizeSplit(current, {
                                                      splitId: nodeId,
                                                      sizes: split.childIds.map(() => 1),
                                                  });
                                              });
                                          })}
                                      ></${VirResizeDivider}>
                                  `
                                : nothing}
                            ${renderNode(childId, sizes[index] ?? 1)}
                        `;
                    })}
                </div>
            `;
        }

        const dropPreview = state.dropTarget?.preview;
        const mobileDisplayedTabId = inputs.isMobile
            ? findMobileDisplayedTabId(layout, isAvailable)
            : undefined;
        const focusedTabId = inputs.isMobile
            ? mobileDisplayedTabId
            : findDisplayedTabId(layout, {
                  groupId: focusedGroupId,
                  isAvailable,
              });
        if (focusedTabId !== state.focusedTabId) {
            updateState({
                focusedTabId,
            });
            dispatch(
                new events.focusedTabChanged({
                    detail: focusedTabId,
                }),
            );
        }

        return html`
            ${inputs.isMobile
                ? html`
                      <div
                          class="node group root"
                          style=${css`
                              flex-grow: 1;
                          `}
                      >
                          ${renderStrip({
                              tabIds: listTabIds(layout),
                              displayedTabId: mobileDisplayedTabId,
                              groupId: undefined,
                          })}
                          ${renderBody(mobileDisplayedTabId)}
                      </div>
                  `
                : html`
                      <div class="node root">${renderNode(layout.rootId, 1)}</div>
                  `}
            ${dropPreview
                ? html`
                      <div
                          class="drop-preview"
                          style=${css`
                              left: ${dropPreview.left}px;
                              top: ${dropPreview.top}px;
                              width: ${dropPreview.width}px;
                              height: ${dropPreview.height}px;
                          `}
                      ></div>
                  `
                : nothing}
        `;
    },
});
