import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html} from 'element-vir';
import {tooltip} from 'vira';

/**
 * Gives a tooltip to the element slotted into it. CodeMirror widgets and gutter markers build raw
 * DOM, which the `tooltip` directive can't attach to outside of a template.
 */
export const VirDiffWidgetTooltip = defineAppElement<{
    text: string;
}>()({
    tagName: 'vir-diff-widget-tooltip',
    styles: css`
        :host,
        .anchor {
            display: inline-flex;
        }

        /**
         * CodeMirror's content sets white-space: pre, which would otherwise keep the whitespace in
         * the tooltip's shadow template as blank lines and leading spaces.
         */
        vira-tooltip {
            white-space: normal;
        }
    `,
    render({inputs}) {
        return html`
            <span class="anchor" ${tooltip(inputs.text)}><slot></slot></span>
        `;
    },
});
