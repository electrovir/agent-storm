import {touchRepoEndpoint} from '@agent-storm/common';
import {
    type ActivityRoute,
    type AppContext,
    defineAppElement,
    fetchApi,
    ScreenSize,
} from '@agent-storm/core/frontend';
import {findReviewState, getFolderVerdictStatuses} from '@agent-storm/plugin-review';
import {HttpMethod} from '@rest-vir/api';
import {css, html, listen} from 'element-vir';
import {buildMemory} from '../../util/build-memory.js';
import {subPathsForFolder} from '../../util/build-route.js';
import {VirSidebar} from './vir-sidebar.element.js';

/** The Build tab's folder list, wired to the app: picking a folder routes to it. */
export const VirBuildSidebar = defineAppElement<{
    context: AppContext;
    route: ActivityRoute;
    activeFolder: string | undefined;
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
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        return html`
            <${VirSidebar.assign({
                activeFolder: inputs.activeFolder,
                folderData: inputs.context.folderData,
                prStatusOverrides: getFolderVerdictStatuses({
                    prReviews: findReviewState(inputs.context).prReviews.value,
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
                        inputs.route.navigate(subPathsForFolder(folder, folderInfo));
                    }
                })}
                ${listen(VirSidebar.events.paneTabRequested, (event) => {
                    inputs.context.uiLayout.showPaneTab({
                        folder: event.detail.folder,
                        kind: event.detail.kind,
                    });
                })}
                ${listen(VirSidebar.events.foldersRemoved, (event) => {
                    /**
                     * Killed panes and hidden repos are still in the folder list, so everything
                     * here is synchronous: while `folderInfo` still holds a removed folder the
                     * build stage would keep its pane group mounted, and the bare Build route would
                     * restore it from the not-yet-cleared selection.
                     */
                    inputs.context.folderData.removeFolders(event.detail);
                    if (inputs.activeFolder && event.detail.includes(inputs.activeFolder)) {
                        if (!inputs.context.isInActivityTab) {
                            buildMemory.selectedFolder.clear();
                        }
                        inputs.route.navigate([]);
                    }
                })}
                ${listen(VirSidebar.events.paneRestarted, async (event) => {
                    await inputs.context.paneRestarts.restart(event.detail);
                })}
                ${listen(VirSidebar.events.openSettingsRequested, (event) => {
                    inputs.context.openSettings(event.detail);
                })}
            ></${VirSidebar}>
        `;
    },
});
