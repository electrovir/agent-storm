import {clamp} from '@augment-vir/common';
import {css, html, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {paneSplit, type Setting} from '../../util/local-storage-client.js';
import {defineAppElement} from '../define-app-element.js';
import {VirResizeDivider} from './vir-resize-divider.element.js';

/**
 * A pane group's side-by-side panes with a resize divider between them: the start slot's pane on
 * the left, the default slot's on the right. Panes mark themselves with `data-hidden` (hidden on
 * mobile, where only one pane shows), `data-collapsed` (out of the layout), and
 * `data-pane-focused`.
 */
export const VirPaneSplit = defineAppElement<{
    /** Where the left pane's share of the width is stored. */
    splitSetting: Readonly<Setting<number>>;
    isMobile: boolean;
}>()({
    tagName: 'vir-pane-split',
    slotNames: [
        'vir-pane-split-start',
    ],
    hostClasses: {
        'vir-pane-split-mobile'({inputs}) {
            return inputs.isMobile;
        },
    },
    state() {
        return {
            split: paneSplit.default as number,
        };
    },
    init({inputs, updateState}) {
        updateState({
            split: inputs.splitSetting.read(),
        });
    },
    styles({hostClasses}) {
        return css`
            :host {
                position: absolute;
                inset: 0;
                display: flex;
                flex-direction: row;
                overflow: hidden;
            }

            :host([data-hidden]) {
                /*
                 * Keep the hidden side mounted so the terminals' live PTY sockets survive a tab
                 * switch. Hiding by visibility preserves that, and killing pointer events makes the
                 * hidden side inert to clicks.
                 */
                visibility: hidden;
                pointer-events: none;
            }

            .start::slotted(*) {
                flex-grow: var(--pane-split-start-grow);
            }

            .end::slotted(*) {
                flex-grow: var(--pane-split-end-grow);
                border-left: 1px solid ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            /* Desktop shows both sides at once, so a swapped-out pane has to leave the layout. */
            ::slotted([data-collapsed]) {
                display: none;
            }

            /*
             * Dims whichever pane keystrokes won't land in. Driven by an attribute rather than
             * :focus-within because xterm's hidden textarea blurs on window blur and doesn't reliably
             * refocus on return, which would drop the highlight.
             */
            ::slotted([data-pane-focused='false']) {
                filter: brightness(0.75) saturate(0.9);
            }

            ${hostClasses['vir-pane-split-mobile'].selector} {
                & ${VirResizeDivider}, & ::slotted([data-hidden]) {
                    display: none;
                }

                & ::slotted(:not([data-hidden])) {
                    flex-grow: 1;
                }
            }
        `;
    },
    render({inputs, state, updateState, host, slotNames}) {
        host.style.setProperty('--pane-split-start-grow', String(state.split));
        host.style.setProperty('--pane-split-end-grow', String(1 - state.split));

        return html`
            <slot class="start" name=${slotNames['vir-pane-split-start']}></slot>
            <${VirResizeDivider}
                ${listen(VirResizeDivider.events.dragged, (event) => {
                    const rect = host.getBoundingClientRect();
                    if (rect.width > 0) {
                        updateState({
                            split: clamp(
                                (event.detail.clientX - rect.left) / rect.width,
                                paneSplit,
                            ),
                        });
                    }
                })}
                ${listen(VirResizeDivider.events.dragEnded, () => {
                    inputs.splitSetting.write(host.instanceState.split);
                })}
                ${listen(VirResizeDivider.events.resetRequested, () => {
                    updateState({
                        split: paneSplit.default,
                    });
                    inputs.splitSetting.write(paneSplit.default);
                })}
            ></${VirResizeDivider}>
            <slot class="end"></slot>
        `;
    },
});
