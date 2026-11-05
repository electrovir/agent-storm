import {touchRepoEndpoint} from '@agent-storm/common';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen} from 'element-vir';
import {fetchApi} from '../../util/api-client.js';
import {AppModal, type AppContext} from '../../util/app-context.js';
import {routeForFolder} from '../../util/app-route.js';
import {getFolderVerdictStatuses} from '../../util/frontend-state.js';
import {bareMainTabPaths, MainTab, router} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirSidebar} from './vir-sidebar.element.js';

/** The Build tab's folder list, wired to the app: picking a folder routes to it. */
export const VirBuildSidebar = defineAppElement<{
    context: AppContext;
    heading?: string | undefined;
}>()({
    tagName: 'vir-build-sidebar',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
        }

        ${VirSidebar} {
            flex-grow: 1;
            min-height: 0;
        }
    `,
    render({inputs}) {
        const frontendState = inputs.context.frontendState?.value;
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        return html`
            <${VirSidebar.assign({
                activeFolder: inputs.context.resolved.activeFolder?.path,
                folderData: inputs.context.folderData,
                prStatusOverrides:
                    frontendState &&
                    getFolderVerdictStatuses({
                        frontendState,
                        folderInfo: inputs.context.folderData.value.folderInfo,
                    }),
                themeClient: inputs.context.themeClient,
                hideBorder: isMobile,
                mobileModal: isMobile,
                heading: inputs.heading,
            })}
                ${listen(VirSidebar.events.folderActivated, async (event) => {
                    /**
                     * Stamp the activated folder's owning repo with a fresh `lastInteractedAtMs`
                     * for future "recently used" sorts. Best-effort: backend resolves worktrees to
                     * their parent repo, and silently no-ops if the path isn't in config (e.g.
                     * stale folder). Fire-and-forget — never block route navigation on this.
                     */
                    void fetchApi(touchRepoEndpoint, HttpMethod.Post, {
                        requestData: {
                            folder: event.detail,
                        },
                    }).catch(() => {
                        /* metadata write only — surface errors elsewhere if at all */
                    });
                    /**
                     * A freshly created worktree isn't in `folderInfo` until the next folder poll,
                     * so poll now rather than dropping the activation.
                     */
                    if (!inputs.context.folderData.value.folderInfo.has(event.detail)) {
                        await inputs.context.folderData.refresh();
                    }
                    const folderInfo = inputs.context.folderData.value.folderInfo;
                    const folder = folderInfo.get(event.detail);
                    if (folder) {
                        router.setRoute(routeForFolder(folder, folderInfo));
                    }
                })}
                ${listen(VirSidebar.events.foldersRemoved, async (event) => {
                    /**
                     * Killed panes and hidden repos are still in the folder list, so everything
                     * here is synchronous: while `folderInfo` still holds a removed folder the
                     * build stage would keep its pane group mounted, and the bare Build route would
                     * restore it from the not-yet-cleared selection.
                     */
                    inputs.context.folderData.removeFolders(event.detail);
                    const activeFolder = inputs.context.resolved.activeFolder;
                    if (activeFolder && event.detail.includes(activeFolder.path)) {
                        router.setRoute({
                            paths: bareMainTabPaths[MainTab.Build],
                        });
                        await frontendState?.localDbClient.set.build({});
                    }
                })}
                ${listen(VirSidebar.events.paneRestarted, async (event) => {
                    await inputs.context.paneRestarts.restart(event.detail);
                })}
                ${listen(VirSidebar.events.openSettingsRequested, () => {
                    inputs.context.openModal.setValue(AppModal.Settings);
                })}
                ${listen(VirSidebar.events.openAiModalRequested, () => {
                    inputs.context.openModal.setValue(AppModal.Ai);
                })}
            ></${VirSidebar}>
        `;
    },
});
