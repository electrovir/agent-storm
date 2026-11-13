import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraInput} from 'vira';
import {defineAppElement} from '../define-app-element.js';

/**
 * Whether a mouse button or finger is down anywhere on the page. A click on a search result blurs
 * the input on press, and clearing the query right then re-filters the list under the pointer, so
 * the release lands on whatever row slid into that spot.
 */
const pointerState = {
    isDown: false,
};
globalThis.addEventListener(
    'pointerdown',
    () => {
        pointerState.isDown = true;
    },
    {
        capture: true,
    },
);
globalThis.addEventListener(
    'pointerup',
    () => {
        pointerState.isDown = false;
    },
    {
        capture: true,
    },
);
globalThis.addEventListener(
    'pointercancel',
    () => {
        pointerState.isDown = false;
    },
    {
        capture: true,
    },
);

/**
 * A sidebar header's search input, stretching across the header's free space. Leaving the input
 * clears the query, except by clicking an element marked with a `data-sidebar-search-result`
 * attribute, so the results stay listed after picking one. Its events bubble, so the sidebar
 * listens for them on its header.
 */
export const VirSidebarSearch = defineAppElement<{
    query: string;
    /** Whether Enter has a result to open. */
    hasResult: boolean;
}>()({
    tagName: 'vir-sidebar-search',
    events: {
        searchQueryChange: defineElementEvent<string>(),
        /** Enter in the input, only fired while `hasResult` is set. */
        searchSubmit: defineElementEvent<void>(),
    },
    /**
     * `ViraInput` is taller than the header's small buttons and pins its own minimum height inside
     * its shadow root, so it floats centered over the header's padding instead of sizing the row.
     */
    styles: css`
        :host {
            position: relative;
            align-self: stretch;
            flex-grow: 1;
            min-width: 0;
        }

        ${ViraInput} {
            position: absolute;
            top: 50%;
            left: 0;
            width: 100%;
            transform: translateY(-50%);
        }
    `,
    render({inputs, dispatch, events}) {
        function clearSearch() {
            dispatch(
                new events.searchQueryChange({
                    detail: '',
                }),
            );
        }

        return html`
            <${ViraInput.assign({
                value: inputs.query,
                placeholder: 'Search',
                showClearButton: true,
            })}
                ${listen(ViraInput.events.valueChange, (event) => {
                    dispatch(
                        new events.searchQueryChange({
                            detail: event.detail,
                        }),
                    );
                })}
                ${listen('keydown', (event) => {
                    if (!(event instanceof KeyboardEvent)) {
                        return;
                    } else if (event.key === 'Escape') {
                        /** The real `<input>`, from inside `ViraInput`'s shadow root. */
                        const nativeInput = event.composedPath()[0];
                        if (nativeInput instanceof HTMLElement) {
                            nativeInput.blur();
                        }
                    } else if (event.key === 'Enter' && inputs.hasResult) {
                        dispatch(
                            new events.searchSubmit({
                                detail: undefined,
                            }),
                        );
                        clearSearch();
                    }
                })}
                ${listen('focusout', () => {
                    if (pointerState.isDown) {
                        const clickState = {
                            isOnResult: false,
                        };
                        function checkClick(event: Event) {
                            clickState.isOnResult = event.composedPath().some((target) => {
                                return (
                                    target instanceof Element &&
                                    target.hasAttribute('data-sidebar-search-result')
                                );
                            });
                        }
                        globalThis.addEventListener('click', checkClick, {
                            capture: true,
                        });
                        /**
                         * A click fires right after the release, in the same task, so a timer
                         * started on release runs after the click has been seen.
                         */
                        globalThis.addEventListener(
                            'pointerup',
                            () => {
                                setTimeout(() => {
                                    globalThis.removeEventListener('click', checkClick, {
                                        capture: true,
                                    });
                                    if (!clickState.isOnResult) {
                                        clearSearch();
                                    }
                                });
                            },
                            {
                                once: true,
                            },
                        );
                    } else {
                        clearSearch();
                    }
                })}
            ></${ViraInput}>
        `;
    },
});
