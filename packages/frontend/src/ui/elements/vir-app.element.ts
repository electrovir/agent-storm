import {type FolderInfo} from '@agent-storm/common';
import {css, defineElement, html, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {getFolders} from '../../util/api-client.js';
import {localStorageClient, sidebarWidth} from '../../util/local-storage-client.js';
import {router, type AppRoute} from '../../util/router.js';
import '../../util/service-origin.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirBook} from './vir-book.element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

const folderInfoPollMs = 2_000;

function clampSidebarWidth(value: number): number {
    if (!Number.isFinite(value)) {
        return sidebarWidth.default;
    }
    return Math.min(sidebarWidth.max, Math.max(sidebarWidth.min, value));
}

type AppState = {
    activeFolder: string | undefined;
    openedFolders: ReadonlyArray<string>;
    folderInfo: Map<string, FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    settingsOpen: boolean;
    route: AppRoute;
    removeRouteListener: (() => void) | undefined;
    sidebarWidth: number;
    sidebarDragging: boolean;
};

type AppUpdate = (newState: Partial<AppState>) => void;

export const VirApp = defineElement()({
    tagName: 'vir-app',
    state(): AppState {
        return {
            activeFolder: undefined,
            openedFolders: [],
            folderInfo: new Map(),
            pollHandle: undefined,
            settingsOpen: false,
            route: router.readCurrentRoute(),
            removeRouteListener: undefined,
            sidebarWidth: localStorageClient.sidebarWidth.read(),
            sidebarDragging: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
            font-family: ui-sans-serif, system-ui, sans-serif;
            background: ${viraThemeByKeys.grey['behind-bg'].body.background.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
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
    `,
    init({updateState}) {
        void refreshFolderInfo(updateState);
        const pollHandle = setInterval(() => {
            void refreshFolderInfo(updateState);
        }, folderInfoPollMs);
        const removeRouteListener = router.listen(true, (route) => {
            updateState({route});
        });
        updateState({pollHandle, removeRouteListener});
    },
    cleanup({state}) {
        if (state.pollHandle) {
            clearInterval(state.pollHandle);
        }
        state.removeRouteListener?.();
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

        const onDividerMouseDown = (event: MouseEvent) => {
            event.preventDefault();

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the terminal canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestWidth = currentSidebarWidth;
            updateState({sidebarDragging: true});

            const onMove = (moveEvent: MouseEvent) => {
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestWidth = clampSidebarWidth(moveEvent.clientX - rect.left);
                updateState({sidebarWidth: latestWidth});
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({sidebarDragging: false});
                localStorageClient.sidebarWidth.write(latestWidth);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({sidebarWidth: sidebarWidth.default});
            localStorageClient.sidebarWidth.write(sidebarWidth.default);
        };

        return html`
            <${VirSidebar.assign({
                activeFolder: state.activeFolder,
                onActivate: (folder: string) => {
                    const openedFolders = state.openedFolders.includes(folder)
                        ? state.openedFolders
                        : [
                              ...state.openedFolders,
                              folder,
                          ];
                    updateState({activeFolder: folder, openedFolders});
                },
                onOpenSettings: () => updateState({settingsOpen: true}),
            })}></${VirSidebar}>
            <div
                class="sidebar-divider ${state.sidebarDragging ? 'dragging' : ''}"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize. Double-click to reset."
                ${listen('mousedown', onDividerMouseDown)}
                ${listen('dblclick', onDividerDoubleClick)}
            ></div>
            <div class="stage">
                ${state.openedFolders.length === 0
                    ? html`
                          <div class="stage-empty">Select a repo to open its panes.</div>
                      `
                    : ''}
                ${state.openedFolders.map((folder) => {
                    const info = state.folderInfo.get(folder);
                    const active = folder === state.activeFolder;
                    return html`
                        <div class="pane-slot" ?data-active=${active}>
                            <${VirPaneGroup.assign({
                                folder,
                                aiHidden: !!info?.aiHidden,
                                active,
                            })}></${VirPaneGroup}>
                        </div>
                    `;
                })}
            </div>
            <${VirSettingsModal.assign({
                open: state.settingsOpen,
                onClose: () => updateState({settingsOpen: false}),
            })}></${VirSettingsModal}>
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
        updateState({folderInfo});
    } catch {
        /* sidebar surfaces the load error */
    }
}
