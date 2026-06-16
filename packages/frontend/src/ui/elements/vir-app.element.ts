import {PaneKind, type FolderInfo} from '@agent-storm/common';
import {colorCss} from '@electrovir/color';
import {attachOnResize, css, defineElement, html, listen, repeat} from 'element-vir';
import {themeDefaultKey} from 'theme-vir';
import {
    createSizedIcon,
    lucideIcons,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraModal,
    ViraSize,
    viraTheme,
    viraThemeByKeys,
    ViraThemeClient,
} from 'vira';
import {getFolders, touchRepo} from '../../util/api-client.js';
import {localStorageClient, sidebarWidth} from '../../util/local-storage-client.js';
import {
    defaultFrontendTab,
    router,
    tabFromRoute,
    type AppRoute,
    type FrontendPaths,
} from '../../util/router.js';
import {determineScreenSize, ScreenSize} from '../../util/screen-size.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirBook} from './vir-book.element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

/**
 * Result of resolving the current URL against the live folder list.
 *
 * - `folder` — the activated `FolderInfo` (standalone repo or worktree child) when the URL points to
 *   a folder we can resolve. Used as the sidebar's `activeFolder` + the visible pane group.
 * - `redirectToRoot` — when the URL is non-trivial but invalid given the current folder list (e.g.
 *   `/<repoName>` where that repo has worktrees, or `/<repoName>/<worktreeName>` where neither
 *   exists). `vir-app` reacts by calling `router.setRoute({paths: []})` to bounce the user back to
 *   `/`. Suppressed when folder info hasn't loaded yet so we don't fight a still-loading page.
 */
type RouteResolution = {
    folder: FolderInfo | undefined;
    redirectToRoot: boolean;
};

function resolveRoute(
    routePaths: ReadonlyArray<string>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): RouteResolution {
    /**
     * Reserved literal — element-book route doesn't map to a folder. Also bail before folder info
     * has loaded so we don't redirect a URL that might be perfectly valid once data arrives.
     */
    if (routePaths[0] === 'book' || routePaths.length === 0 || folderInfo.size === 0) {
        return {
            folder: undefined,
            redirectToRoot: false,
        };
    }
    const [
        repoName,
        worktreeName,
    ] = routePaths;
    const folders = Array.from(folderInfo.values());
    if (!worktreeName) {
        /**
         * Single-segment URL: only valid if it matches a standalone (non-worktree-root, no-parent)
         * repo. Worktree-root matches are explicitly invalid per the route spec — the user must
         * pick a worktree segment.
         */
        const standalone = folders.find(
            (folder) =>
                folder.name === repoName && !folder.isWorktreeRoot && !folder.parentRepoPath,
        );
        if (standalone) {
            return {
                folder: standalone,
                redirectToRoot: false,
            };
        }
        return {
            folder: undefined,
            redirectToRoot: true,
        };
    }
    const repoRoot = folders.find((folder) => folder.name === repoName && folder.isWorktreeRoot);
    if (!repoRoot) {
        return {
            folder: undefined,
            redirectToRoot: true,
        };
    }
    const worktree = folders.find(
        (folder) => folder.parentRepoPath === repoRoot.path && folder.name === worktreeName,
    );
    return {
        folder: worktree,
        redirectToRoot: !worktree,
    };
}

/**
 * Compute the URL paths that should represent the given folder.
 *
 * - Standalone repo → `[folder.name]`.
 * - Worktree child → `[parentRepoName, folder.name]` (we resolve the parent's name through
 *   `folderInfo`; falls back to its basename via `parentRepoPath` if for some reason the parent
 *   isn't in the map).
 * - Worktree root → `[folder.name]` (the activation path for worktree-roots is "user clicked a
 *   child", so this branch is mostly defensive; if it ever fires the redirect-to-root logic above
 *   will undo it on the next render).
 */
function pathsForFolder(
    folder: FolderInfo,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): FrontendPaths {
    if (folder.parentRepoPath) {
        const parent = folderInfo.get(folder.parentRepoPath);
        const parentName = parent?.name || folder.parentRepoPath.split('/').findLast(Boolean);
        return [
            parentName || folder.parentRepoPath,
            folder.name,
        ];
    }
    return [folder.name];
}

const folderInfoPollMs = 2000;

const hamburgerIcon = createSizedIcon(lucideIcons.Menu, 16);

function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) {
        return sidebarWidth.default;
    }
    return Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, value));
}

type AppState = {
    /**
     * Folders the user has clicked into, by absolute path. Kept around so each pane keeps its
     * terminal scrollback when the user switches folders. The currently-active folder is derived
     * from the URL + folder info; this list is the "ever opened during this session" superset.
     */
    openedFolders: ReadonlyArray<string>;
    folderInfo: Map<string, FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    settingsOpen: boolean;
    route: AppRoute;
    removeRouteListener: (() => void) | undefined;
    sidebarWidth: number;
    sidebarDragging: boolean;
    /**
     * Coarse current-viewport bucket (Desktop vs Mobile). Initialized once we have a host element
     * to measure (in `init`) and updated by the resize observer attached there. Drives the docked-
     * vs-modal sidebar layout and the 2-vs-3 tab presentation in `VirPaneGroup`.
     */
    screenSize: ScreenSize;
    /** Disposer for the resize observer attached in `init`; called from `cleanup`. */
    disconnectScreenSizeObserver: (() => void) | undefined;
    /**
     * Disposer for the `window.visualViewport` listeners attached in `init`, which pipe the
     * keyboard-aware viewport height into a `--app-viewport-height` CSS variable on the host.
     * Undefined when the browser doesn't expose `visualViewport` (no listeners attached).
     */
    disconnectVisualViewport: (() => void) | undefined;
    /**
     * Mobile-only: whether the popup sidebar modal is open. Ignored on desktop (sidebar is docked
     * there). Resets to false when the user selects a folder or the modal emits its close event.
     */
    mobileSidebarOpen: boolean;
    paneRestartKeys: Record<string, number | undefined>;
    /**
     * App-wide Vira theme client. Constructed once here (applying the persisted theme + wiring
     * LocalStorage persistence and system color-scheme listening) and passed down to the sidebars
     * via inputs so the theme switcher in the options menu drives a single shared selection.
     */
    themeClient: ViraThemeClient;
};

type AppUpdate = (newState: Partial<AppState>) => void;

export const VirApp = defineElement()({
    tagName: 'vir-app',
    state(): AppState {
        return {
            openedFolders: [],
            folderInfo: new Map(),
            pollHandle: undefined,
            settingsOpen: false,
            route: router.readCurrentRoute(),
            removeRouteListener: undefined,
            sidebarWidth: localStorageClient.sidebarWidth.read(),
            sidebarDragging: false,
            /**
             * Defaults to Desktop and gets corrected by the resize observer in `init` once we
             * actually have a host element to measure. Avoids a flash-of-mobile-on-desktop while
             * the observer fires its first measurement.
             */
            screenSize: ScreenSize.Desktop,
            disconnectScreenSizeObserver: undefined,
            disconnectVisualViewport: undefined,
            mobileSidebarOpen: false,
            paneRestartKeys: {},
            themeClient: new ViraThemeClient(),
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            /*
             * Track the visual viewport (keyboard-aware) height when JS has measured it. iOS
             * Safari's support for the interactive-widget=resizes-content viewport hint is
             * incomplete — 100dvh does NOT consistently shrink when the on-screen keyboard
             * appears, so the textarea xterm focuses ends up under the keyboard and the browser
             * scrolls the tab bar out of view to compensate. The init hook below subscribes to
             * window.visualViewport.resize and writes --app-viewport-height in pixels so the
             * whole app shrinks to the keyboard-free area; the 100dvh fallback covers the brief
             * pre-measure window on first paint, and browsers without the API entirely.
             */
            height: var(--app-viewport-height, 100dvh);
            font-family: sans-serif;
            /*
             * Themed base surface for the whole app (text + background as a Vira color pair). The
             * theme tokens compile to CSS-variable references, so the app, the sidebar (transparent
             * over this), and other chrome recolor live when the theme client swaps the light/dark
             * CSS variables, instead of sitting on the browser's default white.
             */
            ${colorCss(viraTheme.colors[themeDefaultKey])};
            /*
             * Belt-and-braces against the browser's "scroll the focused input into view"
             * behavior: if the layout ever overflows the visible viewport (e.g. during the
             * keyboard's open animation, before we measure the new height), keep the overflow
             * clipped at the app boundary instead of letting the document scroll the tab bar
             * off-screen.
             */
            overflow: hidden;
        }

        vir-sidebar {
            width: var(--sidebar-width, 280px);
            flex-shrink: 0;
        }

        .sidebar-divider {
            flex: 0 0 4px;
            position: relative;
            cursor: col-resize;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            transition: background 120ms ease;
            /* Sit above the sidebar so the hit-area extension below catches the pointer
               instead of being eaten by sidebar event handlers. */
            z-index: 1;
            touch-action: none;
        }

        /* Visible bar stays a thin 4px, but the user gets ~14px of grabbable surface. */
        .sidebar-divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .sidebar-divider:hover,
        .sidebar-divider.dragging {
            background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .stage {
            position: relative;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        .stage-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 13px;
            height: 100%;
        }

        .pane-slot {
            position: absolute;
            inset: 0;
            display: none;
        }

        .pane-slot[data-active] {
            display: block;
        }

        /*
         * Mobile layout overrides. Driven by a data-mobile attribute on :host which the render
         * adds when screenSize is Mobile. The docked sidebar + its drag handle disappear, the
         * stage stretches edge-to-edge, and a hamburger button floats top-left to open the
         * sidebar in a ViraModal popup.
         */
        :host([data-mobile]) > vir-sidebar,
        :host([data-mobile]) > .sidebar-divider {
            display: none;
        }

        .mobile-sidebar-trigger {
            display: none;
        }

        :host([data-mobile]) .mobile-sidebar-trigger {
            display: inline-flex;
            position: absolute;
            top: 6px;
            left: 6px;
            z-index: 2;
        }

        /*
         * Wrapper around the sidebar inside the modal. ViraModal's body slot is content-sized
         * (no defined height), so we hand it explicit dimensions here. Height clamps to a
         * viewport-fraction so the sidebar's flex children (header + scrollable list) have
         * something to grow into instead of collapsing to 0.
         */
        .mobile-sidebar-modal-content {
            width: 100%;
            height: 70dvh;
            max-height: 600px;
            display: flex;
        }

        .mobile-sidebar-modal-content vir-sidebar {
            width: 100%;
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            min-height: 0;
        }
    `,
    init({updateState, host}) {
        void refreshFolderInfo(updateState);
        const pollHandle = setInterval(() => {
            void refreshFolderInfo(updateState);
        }, folderInfoPollMs);
        const removeRouteListener = router.listen(true, (route) => {
            updateState({
                route,
            });
        });
        /**
         * Compute the initial screen size from the host element's current width so the first paint
         * already reflects the right bucket, then attach a ResizeObserver so subsequent viewport
         * changes (window resize, devtools open, iPad rotation, etc.) keep `state.screenSize` in
         * sync.
         */
        let trackedScreenSize = determineScreenSize({
            currentScreenSize: undefined,
            elementWidth: host.clientWidth,
        });
        const {resizeObserver} = attachOnResize(host, ({contentRect}) => {
            /**
             * Track the most-recent screenSize in a closure variable rather than reading from
             * `state` — element-vir's `updateState` takes a Partial<State>, not an updater
             * function, so there's no in-band way to see the freshest value from the listener.
             */
            const nextScreenSize = determineScreenSize({
                currentScreenSize: trackedScreenSize,
                elementWidth: contentRect.width,
            });
            if (nextScreenSize !== trackedScreenSize) {
                trackedScreenSize = nextScreenSize;
                updateState({
                    screenSize: nextScreenSize,
                });
            }
        });
        /**
         * Pipe the visual-viewport height (keyboard-aware) into a CSS custom property on the host.
         * The `:host { height: var(--app-viewport-height, 100dvh) }` rule above reads it, so as
         * soon as the keyboard slides in, the whole app contracts to the keyboard-free area instead
         * of relying on iOS Safari to honor `dvh` updates — which it doesn't do reliably. Listening
         * to both `resize` and `scroll` covers iOS's quirk of firing only the scroll event on some
         * keyboard transitions. The Visual Viewport API is missing on older browsers; skipping the
         * wiring there is safe (the `100dvh` fallback still applies).
         */
        const viewport =
            typeof window === 'undefined' ? undefined : (window.visualViewport ?? undefined);
        const updateViewportHeight = () => {
            const measured = viewport?.height;
            if (typeof measured !== 'number' || measured <= 0) {
                return;
            }
            const value = `${measured}px`;
            /**
             * Write the measured pixel height to both the host (where `:host { height: var(...) }`
             * picks it up) and the document element so the global `html, body` rule in `index.css`
             * can read it too. The body needs to match — if it stayed at `100dvh` (full screen,
             * including the keyboard area), iOS could still pan its visual viewport inside the body
             * and push our tab bar above the fold even though `overflow: hidden` clips document
             * scrolling.
             */
            host.style.setProperty('--app-viewport-height', value);
            document.documentElement.style.setProperty('--app-viewport-height', value);
        };
        if (viewport) {
            updateViewportHeight();
            viewport.addEventListener('resize', updateViewportHeight);
            viewport.addEventListener('scroll', updateViewportHeight);
        }
        const disconnectVisualViewport = viewport
            ? () => {
                  viewport.removeEventListener('resize', updateViewportHeight);
                  viewport.removeEventListener('scroll', updateViewportHeight);
              }
            : undefined;
        updateState({
            pollHandle,
            removeRouteListener,
            screenSize: trackedScreenSize,
            disconnectScreenSizeObserver: () => resizeObserver.disconnect(),
            disconnectVisualViewport,
        });
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
        state.removeRouteListener?.();
        state.disconnectScreenSizeObserver?.();
        state.disconnectVisualViewport?.();
    },
    render({state, updateState, host}) {
        if (state.route.paths[0] === 'book') {
            return html`
                <${VirBook.assign({
                    subPaths: state.route.paths.slice(1),
                })}></${VirBook}>
            `;
        }

        const currentSidebarWidth = clampSidebarWidth(state.sidebarWidth);
        host.style.setProperty('--sidebar-width', `${currentSidebarWidth}px`);

        /**
         * Drive the `data-mobile` attribute on the host element from the current screen size so the
         * mobile-specific CSS rules (hidden sidebar, visible hamburger trigger, etc.) kick in
         * without per-element conditionals in the markup below. Reads like a presence flag in CSS:
         * `:host([data-mobile]) ...`.
         */
        const isMobile = state.screenSize === ScreenSize.Mobile;
        if (isMobile) {
            host.setAttribute('data-mobile', '');
        } else {
            host.removeAttribute('data-mobile');
        }

        /**
         * Single derivation of "the currently active folder" from URL + live folder info. Used to
         * mark the sidebar row, show the right pane group, and set the document title. If the URL
         * can't resolve (mistyped path, repo-with-worktrees + no second segment, etc.) and folder
         * info has actually loaded, bounce the user back to `/` so we don't sit in a broken state.
         */
        const resolution = resolveRoute(state.route.paths, state.folderInfo);
        const activeFolder = resolution.folder?.path;
        if (resolution.redirectToRoot) {
            void Promise.resolve().then(() =>
                router.setRoute({
                    paths: [],
                }),
            );
        }

        /**
         * Keep `openedFolders` in sync with the URL so a freshly-resolved folder mounts its pane
         * without a manual click. Defers the state update via a microtask so we don't mutate during
         * render.
         */
        if (activeFolder && !state.openedFolders.includes(activeFolder)) {
            const newOpened = [
                ...state.openedFolders,
                activeFolder,
            ];
            void Promise.resolve().then(() => {
                updateState({
                    openedFolders: newOpened,
                });
            });
        }

        document.title = resolution.folder
            ? `agent-storm • ${resolution.folder.name}`
            : 'agent-storm';

        const onDividerPointerDown = (event: PointerEvent) => {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag — crucial on touch where the OS otherwise
             * routes events to whatever the touch is currently over.
             */
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the terminal canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestWidth = currentSidebarWidth;
            updateState({
                sidebarDragging: true,
            });

            const onMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestWidth = clampSidebarWidth(moveEvent.clientX - rect.left);
                updateState({
                    sidebarWidth: latestWidth,
                });
            };

            const onUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    sidebarDragging: false,
                });
                localStorageClient.sidebarWidth.write(latestWidth);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({
                sidebarWidth: sidebarWidth.default,
            });
            localStorageClient.sidebarWidth.write(sidebarWidth.default);
        };

        /**
         * Sidebar event handlers extracted so both the docked sidebar (desktop) and the modal
         * sidebar (mobile) can share them. `folderActivated` also closes the mobile sidebar modal —
         * a no-op on desktop because the modal isn't open there anyway.
         */
        const handleFolderActivated = (folderPath: string) => {
            /**
             * Synchronous activation path: the folder is already in vir-app's `folderInfo` cache,
             * so we can set the route immediately. Most clicks hit this branch.
             *
             * Async fallback: a freshly-created worktree (just returned from `/worktrees/create`)
             * won't be in vir-app's cache yet because the cache is polled on a 2 s interval and the
             * sidebar's `getFolders` refresh updates its own state, not ours. Without the fallback
             * the activation drops on the floor and the user has to wait for the next poll to land
             * before the new worktree becomes the active route. Refresh once on demand and retry;
             * if it still isn't there, the activation is genuinely against a stale path and we just
             * keep the entry in `openedFolders` for the eventual poll to catch up.
             */
            const setRouteForFolder = (
                folder: FolderInfo,
                folderInfo: ReadonlyMap<string, FolderInfo>,
            ): void => {
                /**
                 * Wipe `search` on a sidebar click so the new repo starts on the default tab (AI).
                 * Without this, the `?tab=...` value from the previous repo carries over and the
                 * user can land on, say, the Code tab of the freshly- selected repo, which is
                 * usually surprising.
                 */
                router.setRoute({
                    paths: pathsForFolder(folder, folderInfo),
                    search: undefined,
                });
            };
            const known = state.folderInfo.get(folderPath);
            if (known) {
                setRouteForFolder(known, state.folderInfo);
            } else {
                void (async () => {
                    try {
                        const folders = await getFolders();
                        const folderInfo = new Map<string, FolderInfo>();
                        folders.forEach((folder) => folderInfo.set(folder.path, folder));
                        updateState({
                            folderInfo,
                        });
                        const fresh = folderInfo.get(folderPath);
                        if (fresh) {
                            setRouteForFolder(fresh, folderInfo);
                        }
                    } catch {
                        /* sidebar surfaces the load error */
                    }
                })();
            }
            if (!state.openedFolders.includes(folderPath)) {
                updateState({
                    openedFolders: [
                        ...state.openedFolders,
                        folderPath,
                    ],
                });
            }
            /**
             * Stamp the activated folder's owning repo with a fresh `lastInteractedAtMs` for future
             * "recently used" sorts. Best-effort: backend resolves worktrees to their parent repo,
             * and silently no-ops if the path isn't in config (e.g. stale folder). Fire-and-forget
             * — never block route navigation on this.
             */
            void touchRepo({
                folder: folderPath,
            }).catch(() => {
                /* metadata write only — surface errors elsewhere if at all */
            });
            if (state.mobileSidebarOpen) {
                updateState({
                    mobileSidebarOpen: false,
                });
            }
        };

        const handleFoldersRemoved = (paths: ReadonlyArray<string>) => {
            const removed = new Set(paths);
            /**
             * If the URL pointed at one of the gone folders, bounce to root so we don't sit on a
             * broken route. The render-time `redirectToRoot` would catch it on the next sweep, but
             * doing it eagerly avoids a flicker.
             */
            if (activeFolder && removed.has(activeFolder)) {
                router.setRoute({
                    paths: [],
                });
            }
            updateState({
                openedFolders: state.openedFolders.filter((folder) => !removed.has(folder)),
            });
        };

        const handleOpenSettingsRequested = () => {
            updateState({
                settingsOpen: true,
            });
        };

        const handlePaneRestarted = ({
            folder,
            kind,
        }: Readonly<{
            folder: string;
            kind: PaneKind;
        }>) => {
            const paneKey = `${folder}:${kind}`;
            updateState({
                paneRestartKeys: {
                    ...state.paneRestartKeys,
                    [paneKey]: (state.paneRestartKeys[paneKey] || 0) + 1,
                },
            });
        };

        return html`
            <${VirSidebar.assign({
                activeFolder,
                themeClient: state.themeClient,
            })}
                ${listen(VirSidebar.events.folderActivated, (event) =>
                    handleFolderActivated(event.detail),
                )}
                ${listen(VirSidebar.events.foldersRemoved, (event) =>
                    handleFoldersRemoved(event.detail),
                )}
                ${listen(VirSidebar.events.paneRestarted, (event) =>
                    handlePaneRestarted(event.detail),
                )}
                ${listen(VirSidebar.events.openSettingsRequested, () =>
                    handleOpenSettingsRequested(),
                )}
            ></${VirSidebar}>
            <div
                class="sidebar-divider ${state.sidebarDragging ? 'dragging' : ''}"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize. Double-click to reset."
                ${listen('pointerdown', onDividerPointerDown)}
                ${listen('dblclick', onDividerDoubleClick)}
            ></div>
            <div class="stage">
                <${ViraButton.assign({
                    icon: hamburgerIcon,
                    buttonSize: ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Neutral,
                })}
                    class="mobile-sidebar-trigger"
                    title="Open repo list"
                    ${listen('click', () =>
                        updateState({
                            mobileSidebarOpen: true,
                        }),
                    )}
                ></${ViraButton}>
                ${state.openedFolders.length === 0
                    ? html`
                          <div class="stage-empty">Select a repo to open its panes.</div>
                      `
                    : ''}
                ${repeat(
                    state.openedFolders,
                    /**
                     * Key the pane slots by absolute folder path so lit-html identifies elements by
                     * folder rather than by array index. Without this, removing a folder from
                     * `openedFolders` (e.g. via "Kill folder panes") and then opening a _different_
                     * folder at the same array position causes lit to reuse the existing
                     * `VirPaneGroup` / `VirTerminal` elements. Their `init` hooks — which open the
                     * `/pty` WebSocket with the original folder baked into search params — don't
                     * re-run when inputs change, so the reused terminal stays attached to the
                     * previous folder's PTY while the UI claims to be showing the new one.
                     */
                    (folder) => folder,
                    (folder) => {
                        const info = state.folderInfo.get(folder);
                        const active = folder === activeFolder;
                        return html`
                            <div class="pane-slot" ?data-active=${active}>
                                <${VirPaneGroup.assign({
                                    folder,
                                    aiHidden: !!info?.aiHidden,
                                    active,
                                    activeTab: tabFromRoute(state.route),
                                    screenSize: state.screenSize,
                                    aiRestartKey:
                                        state.paneRestartKeys[`${folder}:${PaneKind.Ai}`] || 0,
                                })}
                                    ${listen(VirPaneGroup.events.tabRequested, (event) => {
                                        const requestedTab = event.detail;
                                        router.setRoute({
                                            paths: state.route.paths,
                                            /**
                                             * Omit `?tab` from the URL when the requested tab is
                                             * the default — keeps URLs short and matches what
                                             * `tabFromRoute` falls back to anyway.
                                             */
                                            search:
                                                requestedTab === defaultFrontendTab
                                                    ? undefined
                                                    : {
                                                          tab: [requestedTab],
                                                      },
                                        });
                                    })}
                                ></${VirPaneGroup}>
                            </div>
                        `;
                    },
                )}
            </div>
            <${VirSettingsModal.assign({
                open: state.settingsOpen,
            })}
                ${listen(VirSettingsModal.events.closeRequested, () => {
                    updateState({
                        settingsOpen: false,
                    });
                })}
            ></${VirSettingsModal}>
            <${ViraModal.assign({
                open: isMobile && state.mobileSidebarOpen,
                modalTitle: 'Repos',
                isMobileSize: true,
                noContentPadding: true,
            })}
                ${listen(ViraModal.events.modalClose, () =>
                    updateState({
                        mobileSidebarOpen: false,
                    }),
                )}
            >
                <div class="mobile-sidebar-modal-content">
                    <${VirSidebar.assign({
                        activeFolder,
                        hideBorder: true,
                        mobileModal: true,
                        themeClient: state.themeClient,
                    })}
                        ${listen(VirSidebar.events.folderActivated, (event) =>
                            handleFolderActivated(event.detail),
                        )}
                        ${listen(VirSidebar.events.foldersRemoved, (event) =>
                            handleFoldersRemoved(event.detail),
                        )}
                        ${listen(VirSidebar.events.paneRestarted, (event) =>
                            handlePaneRestarted(event.detail),
                        )}
                        ${listen(VirSidebar.events.openSettingsRequested, () =>
                            handleOpenSettingsRequested(),
                        )}
                    ></${VirSidebar}>
                </div>
            </${ViraModal}>
            <${VirAuthModal}></${VirAuthModal}>
        `;
    },
});

async function refreshFolderInfo(updateState: AppUpdate): Promise<void> {
    try {
        const folders = await getFolders();
        const folderInfo = new Map<string, FolderInfo>();
        folders.forEach((folder) => {
            folderInfo.set(folder.path, folder);
        });
        updateState({
            folderInfo,
        });
    } catch {
        /* sidebar surfaces the load error */
    }
}
