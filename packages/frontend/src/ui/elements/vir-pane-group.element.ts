import {PaneKind} from '@agent-storm/common';
import {css, defineElement, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {VirTerminal} from './vir-terminal.element.js';

export const VirPaneGroup = defineElement<{
    folder: string;
    aiHidden: boolean;
}>()({
    tagName: 'vir-pane-group',
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
            gap: 1px;
        }

        .pane {
            flex-grow: 1;
            flex-shrink: 1;
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
        }

        .shell-pane {
            border-left: 1px solid
                var(${viraThemeByKeys.grey.foreground.placeholder.foreground.name});
        }

        .pane-label {
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: var(${viraThemeByKeys.grey.foreground.header.foreground.name});
            padding: 2px 8px;
            border-bottom: 1px solid
                var(${viraThemeByKeys.grey['behind-bg'].decoration.background.name});
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
                    })}></${VirTerminal}>
                </div>
            </div>
        `;
    },
});
