import {defineDiffPane} from '@agent-storm/plugin-diff';
import {html, listen} from 'element-vir';
import {VirPierreDiffView} from './vir-pierre-diff-view.element.js';

/**
 * The Diff pane with its open file's diff drawn by `@pierre/diffs`. Opens only from the new-tab
 * menu.
 */
export const diffV2Pane = defineDiffPane({
    id: 'diff-v2',
    label: 'Diff V2',
    renderCodeView({isHidden, setChunkCount, ...inputs}) {
        return html`
            <${VirPierreDiffView.assign(inputs)}
                ?data-hidden=${isHidden}
                ${listen(VirPierreDiffView.events.chunkCountChange, (event) => {
                    setChunkCount(event.detail);
                })}
            ></${VirPierreDiffView}>
        `;
    },
});
