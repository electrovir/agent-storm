import {
    countElementsBefore,
    defineAppElement,
    findElementIndexAt,
    isActivityEnabled,
    listInlineTabElements,
    trackPointerDrag,
    type AnyActivityDefinition,
    type AppContext,
} from '@agent-storm/core/frontend';
import {css, html, listen, nothing} from 'element-vir';
import {type FullSpaRoute} from 'spa-router-vir';
import {
    ViraTabs,
    ViraTabsBarDirection,
    viraThemeByKeys,
    ViraThemeColorName,
    type ViraTab,
} from 'vira';
import {router} from '../../util/router.js';

const dropLineThicknessPx = 2;

/** Every main tab, in the stored order: listed tabs first, then the rest in their default order. */
function orderMainTabs(
    storedOrder: ReadonlyArray<string>,
    activities: ReadonlyArray<AnyActivityDefinition>,
) {
    const listed = storedOrder
        .filter((id, index) => storedOrder.indexOf(id) === index)
        .map((id) => activities.find((activity) => activity.id === id))
        .filter((activity) => activity != undefined);
    return [
        ...listed,
        ...activities.filter((activity) => !listed.includes(activity)),
    ];
}

/**
 * The app's outermost navigation: a vertical strip pinned to the left of the sidebar, or with
 * `isHorizontal` a row, which is what fits above the sidebar inside the mobile modal. Tabs drag to
 * reorder, and the order is shared by every window.
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
        const order = orderMainTabs(
            context.uiLayout.value.layout?.mainTabOrder || [],
            context.activities,
        );
        const shownTabs = order.filter((tab) => isActivityEnabled(context, tab));

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
                        return {
                            label: count == undefined ? tab.label : `${tab.label} (${count})`,
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
