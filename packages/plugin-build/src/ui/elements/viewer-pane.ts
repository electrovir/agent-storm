import {viewerPaneId} from '@agent-storm/common';
import {
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {extractExtension} from '@augment-vir/common';
import {html, listen} from 'element-vir';
import {defineShape} from 'object-shape-tester';
import {createSizedIcon, LucideEyeIcon} from 'vira';
import {VirPaneViewer} from './vir-pane-viewer.element.js';

/** A Viewer tab's own state. */
const viewerTabStateShape = defineShape({
    /** The file the tab shows. */
    path: '',
});

function renderViewer(params: PaneRenderParams<typeof viewerTabStateShape>) {
    return html`
        <${VirPaneViewer.assign({
            folder: params.folder,
            path: params.tabState.path,
            isShown: params.isDisplayed && params.isActive,
        })}
            ${listen(VirPaneViewer.events.pathChange, (event) => {
                params.writeLayout((current) => {
                    return updateTabState(current, {
                        tabId: params.tabId,
                        state: {
                            path: event.detail,
                        } satisfies typeof viewerTabStateShape.runtimeType,
                    });
                });
            })}
        ></${VirPaneViewer}>
    `;
}

/**
 * A tab showing an HTML, Markdown, or image file. Only an agent's `show_file` tool opens one, so
 * the new-tab menu leaves it out.
 */
export const viewerPane: PaneDefinition<typeof viewerTabStateShape> = {
    id: viewerPaneId,
    tabStateShape: viewerTabStateShape,
    label({tabState}) {
        const {basename, extension} = extractExtension(tabState.path);
        return basename ? `${basename}${extension}` : 'Viewer';
    },
    newTabEntries() {
        return [];
    },
    icon: createSizedIcon(LucideEyeIcon, 14),
    /** Stays mounted once shown so an HTML page keeps its own scroll position and state. */
    mounting: PaneMounting.OnceDisplayed,
    isAvailable() {
        return true;
    },
    render: renderViewer,
};
