import {check} from '@augment-vir/assert';
import {css, html, nothing, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {type AppContext} from '../../util/app-context.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirPaneGroup} from './vir-pane-group.element.js';

/**
 * The Build tab's stage: the pane group of every folder opened this session, showing the active
 * one.
 */
export const VirBuildStage = defineAppElement<{
    /** Absolute path of the folder the route selects. */
    activeFolder: string | undefined;
    context: AppContext;
}>()({
    tagName: 'vir-build-stage',
    state() {
        return {
            /**
             * Folders the user has opened, by absolute path. Kept around so each pane keeps its
             * terminal scrollback when the user switches folders. Folders that leave the folder
             * list are dropped, and only come back once selected again.
             */
            openedFolders: [] as ReadonlyArray<string>,
        };
    },
    styles: css`
        :host {
            display: block;
            position: absolute;
            inset: 0;
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
    render({inputs, state, updateState}) {
        const folderInfo = inputs.context.folderData.value.folderInfo;
        const openedFolders = [
            ...state.openedFolders.filter((folder) => folderInfo.has(folder)),
            ...(inputs.activeFolder && !state.openedFolders.includes(inputs.activeFolder)
                ? [
                      inputs.activeFolder,
                  ]
                : []),
        ];
        if (!check.deepEquals(state.openedFolders, openedFolders)) {
            updateState({
                openedFolders,
            });
        }

        const localDbClient = inputs.context.frontendState?.value.localDbClient;
        if (
            localDbClient &&
            inputs.activeFolder &&
            inputs.activeFolder !== localDbClient.value.build?.selectedFolder
        ) {
            void localDbClient.set.build({
                selectedFolder: inputs.activeFolder,
            });
        }

        /**
         * On mobile, only mount the currently-active folder's pane group. Every mounted pane group
         * holds live `/pty` WebSocket(s), and keeping the whole `openedFolders` superset mounted
         * (as we do on desktop, so switching folders is instant) means a phone can end up holding
         * many open sockets at once — a real battery drain. Unmounting the inactive groups closes
         * only the frontend's socket; the daemon keeps each pane's PTY alive and replays its
         * scrollback when the user switches back. Desktop keeps the full superset mounted.
         */
        const renderedFolders =
            inputs.context.screenSize === ScreenSize.Mobile
                ? openedFolders.filter((folder) => folder === inputs.activeFolder)
                : openedFolders;

        return html`
            ${renderedFolders.length
                ? nothing
                : html`
                      <div class="stage-empty">Select a repo to open its panes.</div>
                  `}
            ${repeat(
                renderedFolders,
                /**
                 * Key the pane slots by absolute folder path so lit-html identifies elements by
                 * folder rather than by array index. Without this, removing a folder from
                 * `openedFolders` (e.g. via "Kill panes") and then opening a _different_ folder at
                 * the same array position causes lit to reuse the existing `VirPaneGroup` /
                 * `VirTerminal` elements. Their `init` hooks — which open the `/pty` WebSocket with
                 * the original folder baked into search params — don't re-run when inputs change,
                 * so the reused terminal stays attached to the previous folder's PTY while the UI
                 * claims to be showing the new one.
                 */
                (folder) => folder,
                (folder) => {
                    return html`
                        <div class="pane-slot" ?data-active=${folder === inputs.activeFolder}>
                            <${VirPaneGroup.assign({
                                context: inputs.context,
                                folder,
                                memoryKey: folder,
                                active: folder === inputs.activeFolder,
                            })}></${VirPaneGroup}>
                        </div>
                    `;
                },
            )}
        `;
    },
});
