import {PaneKind} from '@agent-storm/common';
import {css, defineElement, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {VirTerminal} from './vir-terminal.element.js';

export const VirPaneGroup = defineElement<{
    folder: string;
    aiHidden: boolean;
    /**
     * True when this pane-group is the user's currently focused folder. Forwarded to each
     * `VirTerminal` so they can re-fit and push a fresh size to the server when transitioning to
     * visible — a CSS-hidden pane may have missed window-resize events while it was `display:
     * none`.
     */
    active: boolean;
}>()({
    tagName: 'vir-pane-group',
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
        }

        .pane {
            flex-grow: 1;
            flex-shrink: 1;
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
        }

        /* Dim whichever pane doesn't currently hold keyboard focus so it's obvious which one
           keystrokes will land in. :focus-within matches when any descendant (including across
           the vir-terminal shadow boundary into xterm hidden textarea) has focus. */
        .pane:not(:focus-within) {
            filter: brightness(0.75) saturate(0.9);
            transition: filter 120ms ease;
        }
        .pane:focus-within {
            transition: filter 120ms ease;
        }

        .shell-pane {
            border-left: 1px solid ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .pane-label {
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
            padding: 2px 8px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .pane-body {
            height: calc(100% - 22px);
        }
    `,
    render({inputs}) {
        return html`
            ${inputs.aiHidden
                ? ''
                : html`
                      <div class="pane">
                          <div class="pane-label">AI</div>
                          <div class="pane-body">
                              <${VirTerminal.assign({
                                  folder: inputs.folder,
                                  kind: PaneKind.Ai,
                                  active: inputs.active,
                              })}></${VirTerminal}>
                          </div>
                      </div>
                  `}
            <div class="pane shell-pane">
                <div class="pane-label">Shell</div>
                <div class="pane-body">
                    <${VirTerminal.assign({
                        folder: inputs.folder,
                        kind: PaneKind.Shell,
                        active: inputs.active,
                    })}></${VirTerminal}>
                </div>
            </div>
        `;
    },
});
