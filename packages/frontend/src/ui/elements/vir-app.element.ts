import {getEnumValues} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {css, html, nothing, Observable} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {viraTheme, ViraThemeClient} from 'vira';
import {SettingsSection, type AppContext, type SettingsTarget} from '../../util/app-context.js';
import {followFolderActivations, resolveAppRoute} from '../../util/app-route.js';
import {installClientErrorLog} from '../../util/client-error-log.js';
import {createFolderData} from '../../util/folder-data.js';
import {
    createFrontendState,
    getReviewablePrs,
    type FrontendStateObservable,
    type PrQueueKind,
} from '../../util/frontend-state.js';
import {isSettingsShortcut} from '../../util/keyboard-shortcuts.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {createPaneRestarts} from '../../util/pane-restarts.js';
import {ActivityId, router} from '../../util/router.js';
import {observeScreenSize, ScreenSize} from '../../util/screen-size.js';
import {applyThemeMode} from '../../util/theme-mode.js';
import {createUiLayout} from '../../util/ui-layout.js';
import {trackVisualViewportHeight} from '../../util/visual-viewport.js';
import {defineAppElement} from '../define-app-element.js';
import {activityDefinitions} from './activity-definitions.js';
import {VirActivityPanel} from './vir-activity-panel.element.js';
import {VirAppModals} from './vir-app-modals.element.js';
import {VirBook} from './vir-book.element.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirMobileSidebar} from './vir-mobile-sidebar.element.js';

installClientErrorLog();

export const VirApp = defineAppElement()({
    tagName: 'vir-app',
    state() {
        const folderData = createFolderData();
        return {
            route: router.readCurrentRoute(),
            frontendState: undefined as FrontendStateObservable | undefined,
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
            isDebugTabShown: localStorageClient.showDebugTab.read(),
            settingsTarget: new Observable<SettingsTarget | undefined>({
                defaultValue: undefined,
            }),
            reviewQueue: new Observable<PrQueueKind | undefined>({
                defaultValue: undefined,
            }),
            /** Notifies on every set, since each new object is a new retry. */
            reviewRetry: new Observable<Readonly<{key: string}> | undefined>({
                equalityCheck: undefined,
                defaultValue: undefined,
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
            if (!state.settingsTarget.value) {
                state.settingsTarget.setValue({
                    section: SettingsSection.General,
                });
            }
        }
        globalThis.addEventListener('keydown', openSettingsOnShortcut, true);
        void createFrontendState().then((frontendState) => {
            updateState({
                frontendState,
            });
        });
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
                followFolderActivations(state.folderData),
                localStorageClient.showDebugTab.subscribe((isDebugTabShown) => {
                    updateState({
                        isDebugTabShown,
                    });
                }),
            ],
        });
    },
    cleanup({state}) {
        state.disposers.forEach((dispose) => dispose());
        state.folderData.destroy();
        state.uiLayout.destroy();
        state.frontendState?.destroy();
    },
    render({state}) {
        if (state.route.paths[0] === 'book') {
            return html`
                <${VirBook.assign({
                    routeBase: 'book',
                    subPaths: state.route.paths.slice(1),
                })}></${VirBook}>
            `;
        }

        const frontendState = state.frontendState?.value;
        const resolved = resolveAppRoute({
            route: state.route,
            folderInfo: state.folderData.value.folderInfo,
            isDebugTabShown: state.isDebugTabShown,
            reviewablePrs: frontendState && getReviewablePrs(frontendState),
            rememberedFolderPath:
                frontendState?.localDbClient.value.build?.selectedFolder || undefined,
            rememberedPullRequestKey:
                frontendState?.localDbClient.value.review?.selectedPullRequest || undefined,
        });
        const redirect = resolved.redirect;
        if (redirect) {
            void Promise.resolve().then(() => {
                router.setRoute(redirect.route, {
                    replace: redirect.replace,
                });
            });
        }
        document.title = resolved.activeFolder
            ? `agent-storm • ${resolved.activeFolder.name}`
            : 'agent-storm';

        const context: AppContext = {
            route: state.route,
            resolved,
            screenSize: state.screenSize,
            folderData: state.folderData,
            frontendState: state.frontendState,
            themeClient: state.themeClient,
            isDebugTabShown: state.isDebugTabShown,
            paneRestarts: state.paneRestarts,
            uiLayout: state.uiLayout,
            settingsTarget: state.settingsTarget,
            reviewQueue: state.reviewQueue,
            reviewRetry: state.reviewRetry,
        };
        const isMobile = state.screenSize === ScreenSize.Mobile;

        return html`
            ${isMobile
                ? nothing
                : html`
                      <${VirMainTabs.assign({
                          context,
                      })}></${VirMainTabs}>
                  `}
            ${getEnumValues(ActivityId).map((activityId) => {
                return html`
                    <${VirActivityPanel.assign({
                        context,
                        activityId,
                    })}></${VirActivityPanel}>
                `;
            })}
            ${isMobile && activityDefinitions[resolved.activityId].mobileMenuTitle != undefined
                ? html`
                      <${VirMobileSidebar.assign({
                          context,
                      })}></${VirMobileSidebar}>
                  `
                : nothing}
            <${VirAppModals.assign({
                context,
            })}></${VirAppModals}>
        `;
    },
});
