import {BookMainRoute, ElementBookApp} from 'element-book';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {type ActivityId, type AppRouteUpdate} from '../../util/router.js';
import {isDarkMode, listenToDarkMode} from '../../util/theme-mode.js';
import {defineAppElement} from '../define-app-element.js';
import {prStatusRingPage} from './pr-status-ring.book.js';

/**
 * The `<style>` element `ElementBookApp` writes Vira's dark overrides into, on the whole document
 * rather than just itself.
 */
const elementBookDarkModeStyleId = 'element-book-dark-mode';

export const VirBook = defineAppElement<{
    /** First path segment of the app route the book lives under. */
    routeBase: 'book' | ActivityId.Debug;
    subPaths: ReadonlyArray<string>;
}>()({
    tagName: 'vir-book',
    events: {
        /** The route the book navigated to, under `routeBase`. */
        routeChange: defineElementEvent<AppRouteUpdate>(),
    },
    styles: css`
        :host {
            display: block;
            width: 100%;
            height: 100%;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        element-book-app {
            width: 100%;
            height: 100%;
        }
    `,
    state() {
        return {
            isDark: isDarkMode(),
            stopThemeListener: undefined as (() => void) | undefined,
        };
    },
    init({updateState}) {
        updateState({
            isDark: isDarkMode(),
            stopThemeListener: listenToDarkMode((isDark) => {
                updateState({
                    isDark,
                });
            }),
        });
    },
    cleanup({state}) {
        state.stopThemeListener?.();
        /** Left behind, it would keep the app dark after a later switch to light. */
        globalThis.document.getElementById(elementBookDarkModeStyleId)?.remove();
    },
    render({inputs, state, dispatch, events}) {
        return html`
            <${ElementBookApp.assign({
                pages: [
                    prStatusRingPage,
                ],
                elementBookRoutePaths: [
                    BookMainRoute.Book,
                    ...inputs.subPaths,
                ],
                /** Without this, the book follows the OS setting instead of agent-storm's. */
                darkMode: state.isDark,
            })}
                ${listen(ElementBookApp.events.pathUpdate, (event) => {
                    const newPaths = event.detail;
                    dispatch(
                        new events.routeChange({
                            detail: {
                                paths: [
                                    inputs.routeBase,
                                    ...newPaths.slice(1),
                                ] satisfies ReadonlyArray<string> as [
                                    'book' | ActivityId.Debug,
                                    ...string[],
                                ],
                            },
                        }),
                    );
                })}
            ></${ElementBookApp}>
        `;
    },
});
