import {defineAppElement} from '@agent-storm/core/frontend';
import {getObjectTypedValues, omitObjectKeys} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {classMap, css, defineElementEvent, html, listen} from 'element-vir';
import {
    fittedImageView,
    panImageView,
    zoomImageView,
    type ImageView,
    type Point,
} from '../../util/image-zoom.js';

/** Pointer travel, in pixels, past which a press is a drag instead of a click. */
const dragThreshold = 4;

function readViewport(event: Event) {
    const viewport = extractEventTarget(event, HTMLElement);
    const rect = viewport.getBoundingClientRect();
    const image = viewport.querySelector('img');

    return {
        viewport,
        image,
        center: {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
        },
        naturalWidth: image?.naturalWidth || 0,
        bounds: {
            /** `offsetWidth` ignores the zoom transform, so this is the fitted size. */
            imageSize: {
                width: image?.offsetWidth || 0,
                height: image?.offsetHeight || 0,
            },
            viewportSize: {
                width: rect.width,
                height: rect.height,
            },
        },
    };
}

function subtractPoints({
    point,
    origin,
}: Readonly<{point: Readonly<Point>; origin: Readonly<Point>}>) {
    return {
        x: point.x - origin.x,
        y: point.y - origin.y,
    };
}

function findMidpoint([
    first,
    second,
]: Readonly<
    [
        Readonly<Point>,
        Readonly<Point>,
    ]
>) {
    return {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
    };
}

/**
 * An image shrunk to fit its parent but never stretched past its natural size, like a chat app's
 * image viewer: click to zoom in, option/alt-click to zoom out, scroll or pinch to zoom, drag to
 * pan. A click outside the image emits `outsideClicked` instead of zooming.
 */
export const VirAiChatImageZoom = defineAppElement<{
    imageUrl: string;
    alt: string;
}>()({
    tagName: 'vir-ai-chat-image-zoom',
    events: {
        outsideClicked: defineElementEvent<void>(),
    },
    state() {
        return {
            view: fittedImageView as Readonly<ImageView>,
            /** Pointers pressed on the image, by pointer id, at their latest position. */
            pointers: {} as Readonly<Record<string, Readonly<Point>>>,
            /** Where the current press started. Unset once it moves far enough to be a drag. */
            pressStart: undefined as Readonly<Point> | undefined,
            /** Turns clicks into zooming out. */
            isAltPressed: false,
            removeKeyListeners: undefined as (() => void) | undefined,
        };
    },
    init({updateState}) {
        function trackAlt(event: KeyboardEvent) {
            updateState({
                isAltPressed: event.altKey,
            });
        }
        globalThis.addEventListener('keydown', trackAlt);
        globalThis.addEventListener('keyup', trackAlt);
        updateState({
            removeKeyListeners() {
                globalThis.removeEventListener('keydown', trackAlt);
                globalThis.removeEventListener('keyup', trackAlt);
            },
        });
    },
    cleanup({state}) {
        state.removeKeyListeners?.();
    },
    styles: css`
        :host {
            position: absolute;
            inset: 0;
            display: flex;
        }

        .viewport {
            display: flex;
            flex-grow: 1;
            align-items: center;
            justify-content: center;
            min-width: 0;
            min-height: 0;
            box-sizing: border-box;
            padding: 16px;
            overflow: hidden;
            touch-action: none;
            user-select: none;

            &.zoom-out img {
                cursor: zoom-out;
            }

            &.dragging,
            &.dragging img {
                cursor: grabbing;
            }
        }

        img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            cursor: zoom-in;
        }
    `,
    render({inputs, state, updateState, host, dispatch, events}) {
        function endPress(event: PointerEvent) {
            if (!host.instanceState.pointers[event.pointerId]) {
                return;
            }
            const {center, bounds, naturalWidth, image} = readViewport(event);
            const isClick = event.type === 'pointerup' && !!host.instanceState.pressStart;
            const imageRect = image?.getBoundingClientRect();
            const isOutsideClick =
                isClick &&
                (!imageRect ||
                    event.clientX < imageRect.left ||
                    event.clientX > imageRect.right ||
                    event.clientY < imageRect.top ||
                    event.clientY > imageRect.bottom);
            const clickedView = zoomImageView({
                ...bounds,
                view: host.instanceState.view,
                zoom: event.altKey
                    ? host.instanceState.view.zoom / 2
                    : host.instanceState.view.zoom > 1
                      ? host.instanceState.view.zoom * 2
                      : /** At least the natural size, so the first click shows every pixel. */
                        Math.max(2, naturalWidth / (bounds.imageSize.width || 1)),
                anchor: subtractPoints({
                    point: {
                        x: event.clientX,
                        y: event.clientY,
                    },
                    origin: center,
                }),
            });

            updateState({
                /** Object keys are strings, so a numeric id would never match. */
                pointers: omitObjectKeys(host.instanceState.pointers, [
                    `${event.pointerId}`,
                ]),
                pressStart: undefined,
                view: isClick && !isOutsideClick ? clickedView : host.instanceState.view,
            });

            if (isOutsideClick) {
                dispatch(
                    new events.outsideClicked({
                        detail: undefined,
                    }),
                );
            }
        }

        return html`
            <div
                class=${classMap({
                    viewport: true,
                    'zoom-out': state.isAltPressed,
                    dragging: !!getObjectTypedValues(state.pointers).length && !state.pressStart,
                })}
                ${listen('pointerdown', (event) => {
                    if (event.pointerType === 'mouse' && event.button !== 0) {
                        return;
                    }
                    readViewport(event).viewport.setPointerCapture(event.pointerId);
                    const point = {
                        x: event.clientX,
                        y: event.clientY,
                    };
                    updateState({
                        pointers: {
                            ...host.instanceState.pointers,
                            [`${event.pointerId}`]: point,
                        },
                        /** A second finger turns the press into a pinch, never a click. */
                        pressStart: getObjectTypedValues(host.instanceState.pointers).length
                            ? undefined
                            : point,
                    });
                })}
                ${listen('pointermove', (event) => {
                    const previous = host.instanceState.pointers[event.pointerId];
                    if (!previous) {
                        return;
                    } else if (event.pointerType === 'mouse' && !event.buttons) {
                        /** No button is held, so this press already ended. */
                        endPress(event);
                        return;
                    }
                    const point = {
                        x: event.clientX,
                        y: event.clientY,
                    };
                    const pointers = {
                        ...host.instanceState.pointers,
                        [`${event.pointerId}`]: point,
                    };
                    const pressStart =
                        host.instanceState.pressStart &&
                        Math.hypot(
                            point.x - host.instanceState.pressStart.x,
                            point.y - host.instanceState.pressStart.y,
                        ) < dragThreshold
                            ? host.instanceState.pressStart
                            : undefined;
                    const {center, bounds} = readViewport(event);
                    const [
                        previousFirst,
                        previousSecond,
                    ] = getObjectTypedValues(host.instanceState.pointers);
                    const [
                        first,
                        second,
                    ] = getObjectTypedValues(pointers);

                    const view =
                        previousFirst && previousSecond && first && second
                            ? panImageView({
                                  ...bounds,
                                  view: zoomImageView({
                                      ...bounds,
                                      view: host.instanceState.view,
                                      zoom:
                                          (host.instanceState.view.zoom *
                                              Math.hypot(first.x - second.x, first.y - second.y)) /
                                          Math.hypot(
                                              previousFirst.x - previousSecond.x,
                                              previousFirst.y - previousSecond.y,
                                          ),
                                      anchor: subtractPoints({
                                          point: findMidpoint([
                                              previousFirst,
                                              previousSecond,
                                          ]),
                                          origin: center,
                                      }),
                                  }),
                                  delta: subtractPoints({
                                      point: findMidpoint([
                                          first,
                                          second,
                                      ]),
                                      origin: findMidpoint([
                                          previousFirst,
                                          previousSecond,
                                      ]),
                                  }),
                              })
                            : pressStart
                              ? host.instanceState.view
                              : panImageView({
                                    ...bounds,
                                    view: host.instanceState.view,
                                    delta: subtractPoints({
                                        point,
                                        origin: previous,
                                    }),
                                });

                    updateState({
                        pointers,
                        pressStart,
                        view,
                    });
                })}
                ${listen('pointerup', endPress)}
                ${listen('pointercancel', endPress)}
                ${listen('wheel', (event) => {
                    event.preventDefault();
                    const {center, bounds} = readViewport(event);
                    updateState({
                        view: zoomImageView({
                            ...bounds,
                            view: host.instanceState.view,
                            /**
                             * Pinches on a laptop pad arrive as ctrl+wheel with much smaller
                             * deltas.
                             */
                            zoom:
                                host.instanceState.view.zoom *
                                Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)),
                            anchor: subtractPoints({
                                point: {
                                    x: event.clientX,
                                    y: event.clientY,
                                },
                                origin: center,
                            }),
                        }),
                    });
                })}
            >
                <img
                    src=${inputs.imageUrl}
                    alt=${inputs.alt}
                    draggable="false"
                    style=${css`
                        transform: translate(${state.view.x}px, ${state.view.y}px)
                            scale(${state.view.zoom});
                    `}
                />
            </div>
        `;
    },
});
