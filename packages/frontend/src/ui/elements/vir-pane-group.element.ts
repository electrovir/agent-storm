import {PaneKind} from '@agent-storm/common';
import {css, defineElement, html, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {localStorageClient, paneSplit} from '../../util/local-storage-client.js';
import {VirTerminal} from './vir-terminal.element.js';

function clampSplit(value: number): number {
    if (!Number.isFinite(value)) {
        return paneSplit.default;
    }
    return Math.min(paneSplit.max, Math.max(paneSplit.min, value));
}

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
    state() {
        return {
            split: localStorageClient.paneSplit.read(),
            dragging: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            width: 100%;
            height: 100%;
        }

        .pane {
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            transition: filter 120ms ease;
        }

        .ai-pane {
            flex-grow: var(--ai-grow, 0.5);
        }

        .shell-pane {
            flex-grow: var(--shell-grow, 0.5);
            border-left: 1px solid ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        /* Dim whichever pane doesn't hold keyboard focus so it's obvious which one keystrokes
           will land in. :focus-within crosses the vir-terminal shadow boundary into xterm's
           hidden textarea. */
        .pane:not(:focus-within) {
            filter: brightness(0.75) saturate(0.9);
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

        .divider {
            flex: 0 0 4px;
            position: relative;
            cursor: col-resize;
            background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            transition: background 120ms ease;
            /* Sit above the panes so the hit-area extension below catches the pointer
               instead of being eaten by terminal mousedown handlers. */
            z-index: 1;
            touch-action: none;
        }

        /* Visible bar stays a thin 4px, but the user gets ~14px of grabbable surface. */
        .divider::before {
            content: '';
            position: absolute;
            top: 0;
            bottom: 0;
            left: -5px;
            right: -5px;
        }

        .divider:hover,
        .divider.dragging {
            background: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState, host}) {
        const split = clampSplit(state.split);
        host.style.setProperty('--ai-grow', String(split));
        host.style.setProperty('--shell-grow', String(1 - split));

        const onDividerMouseDown = (event: MouseEvent) => {
            event.preventDefault();

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the xterm canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestSplit = split;
            updateState({dragging: true});

            const onMove = (moveEvent: MouseEvent) => {
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestSplit = clampSplit((moveEvent.clientX - rect.left) / rect.width);
                updateState({split: latestSplit});
            };

            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({dragging: false});
                localStorageClient.paneSplit.write(latestSplit);
            };

            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({split: paneSplit.default});
            localStorageClient.paneSplit.write(paneSplit.default);
        };

        return html`
            ${inputs.aiHidden
                ? ''
                : html`
                      <div class="pane ai-pane">
                          <div class="pane-label">AI</div>
                          <div class="pane-body">
                              <${VirTerminal.assign({
                                  folder: inputs.folder,
                                  kind: PaneKind.Ai,
                                  active: inputs.active,
                              })}></${VirTerminal}>
                          </div>
                      </div>
                      <div
                          class="divider ${state.dragging ? 'dragging' : ''}"
                          role="separator"
                          aria-orientation="vertical"
                          title="Drag to resize. Double-click to reset."
                          ${listen('mousedown', onDividerMouseDown)}
                          ${listen('dblclick', onDividerDoubleClick)}
                      ></div>
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
