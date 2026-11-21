import {
    applyThemeMode,
    applyTypography,
    createFolderData,
    createPaneRestarts,
    createPluginRegistry,
    createUiLayout,
    defineAppElement,
    installClientErrorLog,
    installClientPerfLog,
    isSettingsShortcut,
    observeScreenSize,
    resolvePluginSettings,
    resolveShortcuts,
    ScreenSize,
    SettingsSection,
    VirBook,
    type AppContext,
    type SettingsTarget,
} from '@agent-storm/core/frontend';
import {colorCss} from '@electrovir/color';
import {css, html, listen, nothing, Observable} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {viraTheme, ViraThemeClient} from 'vira';
import {resolveActivityRoute} from '../../util/activity-route.js';
import {bookRouteBase, router} from '../../util/router.js';
import {trackVisualViewportHeight} from '../../util/visual-viewport.js';
import {activityPane} from './activity-pane.js';
import {VirActivityPanel} from './vir-activity-panel.element.js';
import {VirAppModals} from './vir-app-modals.element.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirMobileSidebar} from './vir-mobile-sidebar.element.js';

installClientErrorLog();
installClientPerfLog();

export const VirApp = defineAppElement()({
    tagName: 'vir-app',
    state() {
        const folderData = createFolderData();
        const paneRestarts = createPaneRestarts(folderData);
        const uiLayout = createUiLayout(folderData);
        /** The one theme client, so every theme switcher drives the same selection. */
        const themeClient = new ViraThemeClient({
            applyTheme: applyThemeMode,
        });
        return {
            route: router.readCurrentRoute(),
            folderData,
            paneRestarts,
            uiLayout,
            /**
             * Corrected in `init`, once there's a host to measure. Avoids a flash of mobile on
             * desktop.
             */
            screenSize: ScreenSize.Desktop as ScreenSize,
            themeClient,
            settingsTarget: new Observable<SettingsTarget>({
                defaultValue: {
                    section: SettingsSection.General,
                },
            }),
            isSettingsOpen: new Observable<boolean>({
                defaultValue: false,
            }),
            plugins: createPluginRegistry({
                hostPanes: [
                    activityPane,
                ],
                services: {
                    folderData,
                    paneRestarts,
                    uiLayout,
                    themeClient,
                },
                navigate(paths) {
                    router.setRoute({
                        paths,
                    });
                },
            }),
            disposers: [] as ReadonlyArray<() => void>,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            /*
             * Fixed to the visual viewport's offset so the app stays on screen when iOS pans the
             * visual viewport to reveal a focused input.
             */
            position: fixed;
            top: var(--app-viewport-offset-top, 0px);
            left: 0;
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
             * document scroll the tab bar off-screen. 'clip', not 'hidden', because iOS scrolls a
             * hidden box to reveal a focused input inside it.
             */
            overflow: clip;
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
        updateState({
            disposers: [
                state.folderData.listen(true, ({snapshot}) => {
                    applyTypography(snapshot?.settings);
                }),
                state.isSettingsOpen.listen(true, (isOpen) => {
                    /** Settings lists every plugin's sections, which only a loaded plugin has. */
                    if (isOpen) {
                        state.plugins.requestAll();
                    }
                }),
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
            ],
        });
    },
    cleanup({state}) {
        state.disposers.forEach((dispose) => dispose());
        state.folderData.destroy();
        state.uiLayout.destroy();
        state.plugins.destroy();
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
            themeClient: state.themeClient,
            navigate(paths) {
                router.setRoute({
                    paths,
                });
            },
            ...state.plugins.value.contributions,
            activityStates: state.plugins.value.activityStates,
            plugins: state.plugins,
            isInActivityTab: false,
            renderActivityTab({paths, navigate}) {
                const tabContext: AppContext = {
                    ...context,
                    navigate,
                    isInActivityTab: true,
                };
                const tabResolved = resolveActivityRoute({
                    paths,
                    context: tabContext,
                });
                const tabRedirect = tabResolved.redirect;
                if (tabRedirect) {
                    void Promise.resolve().then(() => {
                        navigate(tabRedirect.paths);
                    });
                }
                const tabActivity = tabResolved.activity;
                if (!tabActivity) {
                    return nothing;
                }
                return html`
                    <${VirActivityPanel.assign({
                        context: tabContext,
                        activity: tabActivity,
                        route: {
                            subPaths: tabResolved.subPaths,
                            navigate(subPaths) {
                                navigate([
                                    tabActivity.id,
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
            readPluginSettings(plugin) {
                return resolvePluginSettings({
                    plugin,
                    settings: (state.folderData.value.live || state.folderData.value.snapshot)
                        ?.settings,
                });
            },
            readShortcuts(action) {
                return resolveShortcuts({
                    action,
                    settings: (state.folderData.value.live || state.folderData.value.snapshot)
                        ?.settings,
                });
            },
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
        const title = resolved.activity?.findTitle?.({
            context,
            state: resolved.state,
            subPaths: resolved.subPaths,
        });
        document.title = title ? `agent-storm • ${title}` : 'agent-storm';
        const isMobile = state.screenSize === ScreenSize.Mobile;
        const activityId = resolved.activity?.id || '';

        return html`
            ${isMobile
                ? nothing
                : html`
                      <${VirMainTabs.assign({
                          context,
                          activityId,
                      })}></${VirMainTabs}>
                  `}
            ${context.activities.map((activity) => {
                const isShown = activity.id === activityId;
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
            ${isMobile && resolved.activity?.mobileMenuTitle != undefined
                ? html`
                      <${VirMobileSidebar.assign({
                          context,
                          activityId,
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
