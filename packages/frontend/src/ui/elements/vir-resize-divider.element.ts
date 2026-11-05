// cspell:words grabbable

import {css, defineElementEvent, html, listen} from 'element-vir';
import {tooltip, viraThemeByKeys} from 'vira';
import {defineAppElement} from '../define-app-element.js';

/**
 * A vertical bar between two side-by-side areas that the user drags to resize them, and
 * double-clicks to reset. The parent does the resizing from the events.
 */
export const VirResizeDivider = defineAppElement()({
    tagName: 'vir-resize-divider',
    events: {
        dragStarted: defineElementEvent<void>(),
        /** `deltaX` is measured from where the drag started. */
        dragged: defineElementEvent<{clientX: number; deltaX: number}>(),
        dragEnded: defineElementEvent<void>(),
        resetRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            isDragging: false,
        };
    },
    hostClasses: {
        'vir-resize-divider-dragging'({state}) {
            return state.isDragging;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                flex-grow: 0;
                flex-shrink: 0;
                width: 4px;
                position: relative;
                cursor: col-resize;
                background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
                transition: background 120ms ease;
                /* Sit above the neighbors so the hit-area extension below catches the pointer
               instead of being eaten by terminal mousedown handlers. */
                z-index: 1;
                touch-action: none;
            }

            /* Visible bar stays a thin 4px, but the user gets ~14px of grabbable surface. */
            .hit-area {
                position: absolute;
                top: 0;
                bottom: 0;
                left: -5px;
                right: -5px;
            }

            :host(:hover),
            ${hostClasses['vir-resize-divider-dragging'].selector} {
                background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }
        `;
    },
    render({updateState, dispatch, events}) {
        function onPointerDown(event: PointerEvent) {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag — crucial on touch where the OS otherwise
             * routes events to whatever the touch is currently over.
             */
            const hitArea = event.currentTarget;
            if (hitArea instanceof Element) {
                hitArea.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the xterm canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            updateState({
                isDragging: true,
            });
            dispatch(
                new events.dragStarted({
                    detail: undefined,
                }),
            );

            function onMove(moveEvent: PointerEvent) {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                dispatch(
                    new events.dragged({
                        detail: {
                            clientX: moveEvent.clientX,
                            deltaX: moveEvent.clientX - event.clientX,
                        },
                    }),
                );
            }

            function onUp(upEvent: PointerEvent) {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    isDragging: false,
                });
                dispatch(
                    new events.dragEnded({
                        detail: undefined,
                    }),
                );
            }

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        }

        return html`
            <div
                class="hit-area"
                role="separator"
                aria-orientation="vertical"
                ${tooltip('Drag to resize. Double-click to reset.')}
                ${listen('pointerdown', onPointerDown)}
                ${listen('dblclick', () => {
                    dispatch(
                        new events.resetRequested({
                            detail: undefined,
                        }),
                    );
                })}
            ></div>
        `;
    },
});
