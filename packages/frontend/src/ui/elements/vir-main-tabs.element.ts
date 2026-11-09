import {check} from '@augment-vir/assert';
import {css, html, listen, nothing} from 'element-vir';
import {type FullSpaRoute} from 'spa-router-vir';
import {
    ViraTabs,
    ViraTabsBarDirection,
    viraThemeByKeys,
    ViraThemeColorName,
    type ViraTab,
} from 'vira';
import {activityInfo, isActivityEnabled} from '../../util/activity-info.js';
import {type AppContext} from '../../util/app-context.js';
import {
    ActivityId,
    bareActivityPaths,
    orderedActivityIds,
    router,
    type AppRouteUpdate,
} from '../../util/router.js';
import {
    countElementsBefore,
    findElementIndexAt,
    listInlineTabElements,
    trackPointerDrag,
} from '../../util/tab-drag.js';
import {defineAppElement} from '../define-app-element.js';
import {activityDefinitions} from './activity-definitions.js';

const dropLineThicknessPx = 2;

/** Every main tab, in the stored order: listed tabs first, then the rest in their default order. */
function orderMainTabs(storedOrder: ReadonlyArray<string>) {
    const listed = storedOrder
        .filter((tab) => check.isEnumValue(tab, ActivityId))
        .filter((tab, index, tabs) => tabs.indexOf(tab) === index);
    return [
        ...listed,
        ...orderedActivityIds.filter((tab) => !listed.includes(tab)),
    ];
}

/**
 * The app's outermost navigation: a vertical strip pinned to the left of the sidebar, or with
 * `isHorizontal` a row, which is what fits above the sidebar inside the mobile modal. Tabs drag to
 * reorder, and the order is shared by every window.
 */
export const VirMainTabs = defineAppElement<{
    context: AppContext;
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

        .tabs {
            display: flex;
            flex-grow: 1;
            min-width: 0;
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
        const order = orderMainTabs(context.uiLayout.value.layout?.mainTabOrder || []);
        const shownTabs = order.filter((tab) => isActivityEnabled(context, tab));

        /** A main tab returns to the folder or PR it was last on. */
        function toTargetRoute(route: Readonly<Partial<FullSpaRoute>>): AppRouteUpdate {
            const routeTab = route.paths?.[0];
            const tab = check.isEnumValue(routeTab, ActivityId)
                ? routeTab
                : context.resolved.activityId;
            return (
                context.resolved.restoredRouteByActivity[tab] || {
                    paths: bareActivityPaths[tab],
                }
            );
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
                        ],
                    });
                },
            });
        }

        const dropLine = state.dropLine;

        return html`
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
                        const label = activityInfo[tab].label;
                        const count = activityDefinitions[tab].findCount(context);
                        return {
                            label: count == undefined ? label : `${label} (${count})`,
                            paths: {
                                path: tab,
                                fullPaths: [
                                    tab,
                                ],
                                PathsType: [
                                    tab,
                                ],
                            },
                        };
                    }),
                    router: mainTabRouter,
                    currentRoute: {
                        paths: [
                            context.resolved.activityId,
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
