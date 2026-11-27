import {
    AgentStormMarkIcon,
    countElementsBefore,
    defineAppElement,
    findElementIndexAt,
    isActivityEnabled,
    listInlineTabElements,
    sidebarContextMenuOffset,
    trackPointerDrag,
    type AppContext,
} from '@agent-storm/core/frontend';
import {css, html, listen, nothing} from 'element-vir';
import {type FullSpaRoute} from 'spa-router-vir';
import {
    createSizedIcon,
    LucideTriangleAlertIcon,
    ViraIcon,
    ViraTabs,
    ViraTabsBarDirection,
    viraThemeByKeys,
    ViraThemeColorName,
    type ViraMenuItemEntry,
    type ViraTab,
} from 'vira';
import {orderMainTabs} from '../../util/activity-route.js';
import {listActivityToggles, setActivityEnabled} from '../../util/activity-toggles.js';
import {router} from '../../util/router.js';

const dropLineThicknessPx = 2;
const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

/**
 * The app's outermost navigation: a vertical strip pinned to the left of the sidebar, or with
 * `isHorizontal` a row, which is what fits above the sidebar inside the mobile modal. Only the
 * vertical strip shows the brand mark, above its tabs. Tabs drag to reorder, and every tab's
 * context menu shows or hides each tab. Both are shared by every window.
 */
export const VirMainTabs = defineAppElement<{
    context: AppContext;
    /** The activity the route selects. */
    activityId: string;
    isHorizontal?: boolean | undefined;
}>()({
    tagName: 'vir-main-tabs',
    state() {
        return {
            /** Where a dragged tab would land, relative to the host. */
            dropLine: undefined as
                | Readonly<{
                      left: number;
                      top: number;
                      width: number;
                      height: number;
                  }>
                | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-shrink: 0;
            position: relative;
            font-size: 12px;
        }

        :host(:not([data-horizontal])) {
            flex-direction: column;
        }

        .tabs {
            display: flex;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        .brand-mark {
            display: flex;
            justify-content: center;
            padding: 8px 0;
            border-right: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        }

        .drop-line {
            position: absolute;
            z-index: 3;
            background: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            pointer-events: none;
        }
    `,
    render({inputs, state, updateState, host}) {
        const context = inputs.context;
        const isVertical = !inputs.isHorizontal;
        host.toggleAttribute('data-horizontal', !isVertical);
        const order = orderMainTabs(
            context.uiLayout.value.layout?.mainTabOrder || [],
            context.activities,
        );
        const shownTabs = order.filter((tab) => isActivityEnabled(context, tab));
        const visibilityMenuEntries = listActivityToggles({
            context,
            activities: order,
        }).map(({activity, isEnabled, isLastEnabled}): ViraMenuItemEntry => {
            return {
                content: activity.label,
                selected: isEnabled,
                disabled: isLastEnabled,
                keepOpenAfterInteraction: true,
                onClick() {
                    setActivityEnabled({
                        context,
                        activity,
                        isEnabled: !isEnabled,
                    });
                },
            };
        });

        /** A main tab returns to what it last had selected. */
        function toTargetRoute(route: Readonly<Partial<FullSpaRoute>>) {
            const tabId = route.paths?.[0] || inputs.activityId;
            const tab = context.activities.find((activity) => activity.id === tabId);
            return {
                paths: [
                    tabId,
                    ...(tab?.findRestoredSubPaths?.({
                        context,
                        state: context.activityStates[tabId],
                    }) || []),
                ],
            };
        }

        const mainTabRouter: (typeof ViraTabs.InputsType)['router'] = {
            createRouteUrl(route) {
                return router.createRouteUrl(toTargetRoute(route));
            },
            setRouteOnDirectNavigation(route, event) {
                return router.setRouteOnDirectNavigation(toTargetRoute(route), event);
            },
        };

        function findInsertIndex({
            elements,
            draggedIndex,
            position,
        }: Readonly<{
            elements: ReadonlyArray<Element>;
            draggedIndex: number;
            position: number;
        }>) {
            return countElementsBefore({
                elements: elements.filter((element, index) => index !== draggedIndex),
                position,
                isVertical,
            });
        }

        function onPointerDown(event: PointerEvent) {
            const elements = listInlineTabElements(host.shadowRoot.querySelector(ViraTabs.tagName));
            const draggedIndex = findElementIndexAt({
                elements,
                clientX: event.clientX,
                clientY: event.clientY,
            });
            const draggedTab = shownTabs[draggedIndex];
            if (!draggedTab) {
                return;
            }
            trackPointerDrag({
                event,
                captureElement: host,
                onStart() {},
                onMove(moveEvent) {
                    const insertIndex = findInsertIndex({
                        elements,
                        draggedIndex,
                        position: isVertical ? moveEvent.clientY : moveEvent.clientX,
                    });
                    const others = elements.filter((element, index) => index !== draggedIndex);
                    const hostRect = host.getBoundingClientRect();
                    const nextRect = others[insertIndex]?.getBoundingClientRect();
                    const previousRect = others[insertIndex - 1]?.getBoundingClientRect();
                    const edge = nextRect
                        ? isVertical
                            ? nextRect.top
                            : nextRect.left
                        : previousRect
                          ? isVertical
                              ? previousRect.bottom
                              : previousRect.right
                          : 0;
                    updateState({
                        dropLine: isVertical
                            ? {
                                  left: 0,
                                  top: edge - hostRect.top - dropLineThicknessPx / 2,
                                  width: hostRect.width,
                                  height: dropLineThicknessPx,
                              }
                            : {
                                  left: edge - hostRect.left - dropLineThicknessPx / 2,
                                  top: 0,
                                  width: dropLineThicknessPx,
                                  height: hostRect.height,
                              },
                    });
                },
                onEnd(endEvent) {
                    updateState({
                        dropLine: undefined,
                    });
                    if (!endEvent) {
                        return;
                    }
                    const insertIndex = findInsertIndex({
                        elements,
                        draggedIndex,
                        position: isVertical ? endEvent.clientY : endEvent.clientX,
                    });
                    const reorderedShown = shownTabs
                        .filter((tab) => tab !== draggedTab)
                        .toSpliced(insertIndex, 0, draggedTab);
                    context.uiLayout.setActivityBar({
                        order: [
                            ...reorderedShown,
                            ...order.filter((tab) => !reorderedShown.includes(tab)),
                        ].map((tab) => tab.id),
                    });
                },
            });
        }

        const dropLine = state.dropLine;

        return html`
            ${isVertical
                ? html`
                      <div class="brand-mark">
                          <${ViraIcon.assign({
                              icon: brandMarkIcon,
                          })}></${ViraIcon}>
                      </div>
                  `
                : nothing}
            <div
                class="tabs"
                role="tablist"
                ${listen('pointerdown', onPointerDown)}
                ${listen('dragstart', (event) => {
                    /**
                     * Each tab is a link, and the browser's own link drag would cancel the pointer
                     * events the tab drag runs on.
                     */
                    event.preventDefault();
                })}
            >
                <${ViraTabs.assign({
                    tabs: shownTabs.map((tab): ViraTab => {
                        const count = tab.findCount?.({
                            context,
                            state: context.activityStates[tab.id],
                        });
                        const isPending = context.plugins.value.pendingActivityIds.includes(tab.id);
                        const label = count == undefined ? tab.label : `${tab.label} (${count})`;
                        return {
                            label: isPending
                                ? html`
                                      <span
                                          style=${css`
                                              opacity: 0.6;
                                          `}
                                      >
                                          ${label}
                                      </span>
                                  `
                                : label,
                            icon: isPending
                                ? createSizedIcon(LucideTriangleAlertIcon, 14)
                                : undefined,
                            contextMenuEntries: visibilityMenuEntries,
                            paths: {
                                path: tab.id,
                                fullPaths: [
                                    tab.id,
                                ],
                                PathsType: [
                                    tab.id,
                                ],
                            },
                        };
                    }),
                    router: mainTabRouter,
                    currentRoute: {
                        paths: [
                            inputs.activityId,
                        ],
                        search: undefined,
                        hash: undefined,
                    },
                    barDirection: isVertical
                        ? ViraTabsBarDirection.Right
                        : ViraTabsBarDirection.Bottom,
                    color: ViraThemeColorName.blue,
                    shouldFillWidth: !isVertical,
                    shouldRotateLabels: isVertical,
                    contextMenuPopoverOffset: sidebarContextMenuOffset,
                })}></${ViraTabs}>
            </div>
            ${dropLine
                ? html`
                      <div
                          class="drop-line"
                          style=${css`
                              left: ${dropLine.left}px;
                              top: ${dropLine.top}px;
                              width: ${dropLine.width}px;
                              height: ${dropLine.height}px;
                          `}
                      ></div>
                  `
                : nothing}
        `;
    },
});
