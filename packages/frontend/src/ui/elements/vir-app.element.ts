import {
    applyThemeMode,
    createFolderData,
    createPaneRestarts,
    createPrReviews,
    createUiLayout,
    defineAppElement,
    installClientErrorLog,
    isSettingsShortcut,
    observeScreenSize,
    ScreenSize,
    SettingsSection,
    VirBook,
    type AppContext,
    type AppServices,
    type SettingsTarget,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {arrayToObject, getObjectTypedValues} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {css, html, isObservableBase, listen, nothing, Observable} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {viraTheme, ViraThemeClient} from 'vira';
import {resolveActivityRoute} from '../../util/activity-route.js';
import {bookRouteBase, router, sanitizeActivityPaths} from '../../util/router.js';
import {trackVisualViewportHeight} from '../../util/visual-viewport.js';
import {activities} from './activity-definitions.js';
import {panes} from './pane-definitions.js';
import {VirActivityPanel} from './vir-activity-panel.element.js';
import {VirAppModals} from './vir-app-modals.element.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirMobileSidebar} from './vir-mobile-sidebar.element.js';

installClientErrorLog();

export const VirApp = defineAppElement()({
    tagName: 'vir-app',
    state() {
        const folderData = createFolderData();
        return {
            route: router.readCurrentRoute(),
            prReviews: createPrReviews(),
            folderData,
            paneRestarts: createPaneRestarts(folderData),
            uiLayout: createUiLayout(folderData),
            /**
             * Corrected in `init`, once there's a host to measure. Avoids a flash of mobile on
             * desktop.
             */
            screenSize: ScreenSize.Desktop as ScreenSize,
            /** The one theme client, so every theme switcher drives the same selection. */
            themeClient: new ViraThemeClient({
                applyTheme: applyThemeMode,
            }),
            settingsTarget: new Observable<SettingsTarget>({
                defaultValue: {
                    section: SettingsSection.General,
                },
            }),
            isSettingsOpen: new Observable<boolean>({
                defaultValue: false,
            }),
            activityStates: arrayToObject(activities, (activity) => {
                return {
                    key: activity.id,
                    value: activity.createState?.(),
                };
            }),
            disposers: [] as ReadonlyArray<() => void>,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            position: relative;
            width: 100%;
            /*
             * iOS Safari's 100dvh doesn't consistently shrink when the on-screen keyboard opens, so
             * the focused terminal ends up under the keyboard. trackVisualViewportHeight measures
             * the keyboard-free height instead; 100dvh covers the first paint and browsers without
             * the visual viewport API.
             */
            height: var(--app-viewport-height, 100dvh);
            /*
             * The theme tokens compile to CSS variables, so the whole app recolors live when the
             * theme client swaps them, instead of sitting on the browser's default white.
             */
            ${colorCss(viraTheme.colors[themeDefaultKey])};
            /*
             * If the layout ever overflows the visible viewport (e.g. during the keyboard's open
             * animation, before the new height is measured), clip it here instead of letting the
             * document scroll the tab bar off-screen.
             */
            overflow: hidden;
        }
    `,
    init({state, updateState, host}) {
        /**
         * Capture phase, so the shortcut still opens Settings while a terminal or input has focus
         * and a handler there would otherwise consume the key first.
         */
        function openSettingsOnShortcut(event: KeyboardEvent) {
            if (!isSettingsShortcut(event)) {
                return;
            }
            event.preventDefault();
            state.isSettingsOpen.setValue(true);
        }
        globalThis.addEventListener('keydown', openSettingsOnShortcut, true);
        const services: AppServices = {
            folderData: state.folderData,
            paneRestarts: state.paneRestarts,
            uiLayout: state.uiLayout,
            themeClient: state.themeClient,
            prReviews: state.prReviews,
        };
        /**
         * `/` (and any unrecognized URL) sanitizes to the Dashboard tab on read, but the window's
         * URL bar only gets corrected when a location change fires. Write it back once on startup
         * so the address bar agrees with what's rendered.
         */
        router.setRoute(router.readCurrentRoute(), {
            replace: true,
        });
        updateState({
            disposers: [
                router.listen(true, (route) => {
                    updateState({
                        route,
                    });
                }),
                observeScreenSize(host, (screenSize) => {
                    updateState({
                        screenSize,
                    });
                }),
                trackVisualViewportHeight(host),
                () => {
                    globalThis.removeEventListener('keydown', openSettingsOnShortcut, true);
                },
                ...getObjectTypedValues(state.activityStates).flatMap((activityState) => {
                    return check.isObject(activityState)
                        ? getObjectTypedValues(activityState)
                              .filter(isObservableBase)
                              .map((observable) => {
                                  return observable.listen(false, () => {
                                      host.requestUpdate();
                                  });
                              })
                        : [];
                }),
                ...activities.flatMap((activity) => {
                    return (
                        activity.startWithApp?.({
                            services,
                            state: state.activityStates[activity.id],
                            navigate(subPaths) {
                                router.setRoute({
                                    paths: [
                                        activity.id,
                                        ...subPaths,
                                    ],
                                });
                            },
                        }) || []
                    );
                }),
            ],
        });
    },
    cleanup({state}) {
        state.disposers.forEach((dispose) => dispose());
        state.folderData.destroy();
        state.uiLayout.destroy();
        state.prReviews.destroy();
    },
    render({state}) {
        if (state.route.paths[0] === bookRouteBase) {
            return html`
                <${VirBook.assign({
                    subPaths: state.route.paths.slice(1),
                })}
                    ${listen(VirBook.events.routeChange, (event) => {
                        router.setRoute({
                            paths: [
                                bookRouteBase,
                                ...event.detail,
                            ],
                        });
                    })}
                ></${VirBook}>
            `;
        }

        const context: AppContext = {
            screenSize: state.screenSize,
            folderData: state.folderData,
            prReviews: state.prReviews,
            themeClient: state.themeClient,
            navigate(paths) {
                router.setRoute({
                    paths,
                });
            },
            activities,
            activityStates: state.activityStates,
            panes,
            isInActivityTab: false,
            renderActivityTab({paths, navigate}) {
                const tabContext: AppContext = {
                    ...context,
                    navigate,
                    isInActivityTab: true,
                };
                const tabResolved = resolveActivityRoute({
                    paths: sanitizeActivityPaths(paths),
                    context: tabContext,
                });
                const tabRedirect = tabResolved.redirect;
                if (tabRedirect) {
                    void Promise.resolve().then(() => {
                        navigate(tabRedirect.paths);
                    });
                }
                return html`
                    <${VirActivityPanel.assign({
                        context: tabContext,
                        activity: tabResolved.activity,
                        route: {
                            subPaths: tabResolved.subPaths,
                            navigate(subPaths) {
                                navigate([
                                    tabResolved.activity.id,
                                    ...subPaths,
                                ]);
                            },
                        },
                        isShown: true,
                    })}></${VirActivityPanel}>
                `;
            },
            paneRestarts: state.paneRestarts,
            uiLayout: state.uiLayout,
            openSettings(target) {
                if (target) {
                    state.settingsTarget.setValue(target);
                }
                state.isSettingsOpen.setValue(true);
            },
        };

        const resolved = resolveActivityRoute({
            paths: state.route.paths,
            context,
        });
        const redirect = resolved.redirect;
        if (redirect) {
            void Promise.resolve().then(() => {
                router.setRoute(
                    {
                        paths: redirect.paths,
                    },
                    {
                        replace: redirect.replace,
                    },
                );
            });
        }
        const title = resolved.activity.findTitle?.({
            context,
            state: resolved.state,
            subPaths: resolved.subPaths,
        });
        document.title = title ? `agent-storm • ${title}` : 'agent-storm';
        const isMobile = state.screenSize === ScreenSize.Mobile;

        return html`
            ${isMobile
                ? nothing
                : html`
                      <${VirMainTabs.assign({
                          context,
                          activityId: resolved.activity.id,
                      })}></${VirMainTabs}>
                  `}
            ${activities.map((activity) => {
                const isShown = activity.id === resolved.activity.id;
                return html`
                    <${VirActivityPanel.assign({
                        context,
                        activity,
                        route: {
                            subPaths: isShown ? resolved.subPaths : [],
                            navigate(subPaths) {
                                context.navigate([
                                    activity.id,
                                    ...subPaths,
                                ]);
                            },
                        },
                        isShown,
                    })}></${VirActivityPanel}>
                `;
            })}
            ${isMobile && resolved.activity.mobileMenuTitle != undefined
                ? html`
                      <${VirMobileSidebar.assign({
                          context,
                          activityId: resolved.activity.id,
                          subPaths: resolved.subPaths,
                      })}></${VirMobileSidebar}>
                  `
                : nothing}
            <${VirAppModals.assign({
                context,
                settingsTarget: state.settingsTarget,
                isSettingsOpen: state.isSettingsOpen,
            })}></${VirAppModals}>
        `;
    },
});
