import {type FolderInfo} from '@agent-storm/common';
import {css, defineElement, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {getFolders} from '../../util/api-client.js';
import {router, type AppRoute} from '../../util/router.js';
import '../../util/service-origin.js';
import {VirAuthModal} from './vir-auth-modal.element.js';
import {VirBook} from './vir-book.element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';
import {VirSettingsModal} from './vir-settings-modal.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

const folderInfoPollMs = 2_000;

type AppState = {
    activeFolder: string | undefined;
    openedFolders: ReadonlyArray<string>;
    folderInfo: Map<string, FolderInfo>;
    pollHandle: ReturnType<typeof setInterval> | undefined;
    settingsOpen: boolean;
    route: AppRoute;
    removeRouteListener: (() => void) | undefined;
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
            width: 280px;
            flex-shrink: 0;
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
    render({state, updateState}) {
        if (state.route.paths[0] === 'book') {
            return html`
                <${VirBook.assign({
                    subPaths: state.route.paths.slice(1),
                })}></${VirBook}>
            `;
        }
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
