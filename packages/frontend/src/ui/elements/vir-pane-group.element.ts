// cspell:words titlebar

import {agentStormService, PaneKind} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {ensureVscode, killVscode} from '../../util/api-client.js';
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
    /**
     * Which tab the parent says is showing. `false` → CLI (terminal panes). `true` → Code (empty
     * placeholder for now). Driven by the `?code` search param up at the app level so the URL is
     * the source of truth.
     */
    codeTabActive: boolean;
}>()({
    tagName: 'vir-pane-group',
    events: {
        /**
         * Emitted when the user clicks the CLI tab. Parent should remove the `?code` search param
         * from the URL (the actual route paths stay the same).
         */
        cliTabRequested: defineElementEvent<void>(),
        /**
         * Emitted when the user clicks the Code tab. Parent should add the `?code` search param to
         * the URL.
         */
        codeTabRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            split: localStorageClient.paneSplit.read(),
            dragging: false,
            /**
             * Which pane last received focus inside this group. Sticky across window blur/focus
             * cycles: a `:focus-within` CSS-based highlight loses match when the user cmd+tabs away
             * (xterm's hidden textarea blurs and doesn't reliably regain focus through the shadow
             * boundary on return), so we mirror focus into local state and drive the highlight off
             * that instead. Undefined before the user has clicked into either pane.
             */
            focusedKind: undefined as PaneKind | undefined,
            /**
             * VS Code iframe URL for THIS folder. Set after the first `ensureVscode` resolves; once
             * set, the iframe stays mounted (hidden when CLI tab is active) so its in-memory editor
             * state survives toggling between tabs. Cleared on close-button click.
             */
            vscodeUrl: undefined as string | undefined,
            vscodeLoading: false,
            vscodeError: undefined as string | undefined,
            /**
             * Set true when the user clicks the close (×) button next to the Code tab. While true,
             * the render-time auto-ensure block is suppressed so the just-killed VS Code doesn't
             * immediately respawn during the brief window where `codeTabActive` is still observed
             * as true (the cliTabRequested event needs a round-trip through vir-app's router state
             * before the prop flips). Reset to false when the user explicitly re-requests the Code
             * tab via the tab-bar button.
             */
            vscodeUserClosed: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        .tab-bar {
            display: flex;
            flex: 0 0 auto;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
        }

        .tab {
            appearance: none;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            padding: 6px 14px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;
            letter-spacing: 0.02em;
            transition:
                color 120ms ease,
                border-bottom-color 120ms ease;
        }

        .tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .close-vscode {
            appearance: none;
            background: transparent;
            border: none;
            padding: 4px 6px;
            margin: 2px 2px 2px 0;
            border-radius: 3px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;
            line-height: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .close-vscode:hover {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .body {
            display: flex;
            flex-direction: row;
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            position: relative;
        }

        .code-pane,
        .cli-panes {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: row;
            /*
             * Clip the iframe's negative margin-top so the shifted-up VS Code workbench doesn't
             * overflow into the tab strip above the pane group. See .vscode-iframe below for the
             * offset itself.
             */
            overflow: hidden;
        }

        .code-pane[data-hidden],
        .cli-panes[data-hidden] {
            /* Keep the iframe mounted across CLI ↔ Code toggles so VS Code's in-memory editor
               state (open files, scroll positions, terminal contents inside the editor) survives.
               visibility:hidden + pointer-events:none preserves the iframe document while making
               the hidden side click-through inert. */
            visibility: hidden;
            pointer-events: none;
        }

        .vscode-iframe {
            /*
             * Shift the iframe up by VS Code's now-hidden (via visibility: hidden in the proxy's
             * injected CSS) title bar height so the empty slot sits behind the agent-storm tab
             * strip. The titlebar still participates in VS Code's grid layout (we kept its slot,
             * just made the bar invisible) so the workbench's grid math stays correct — only the
             * visible offset is adjusted from this side. Bump --vscode-titlebar-offset if your VS
             * Code version has a different titlebar height; 35px matches stable serve-web today.
             */
            --vscode-titlebar-offset: 35px;
            width: 100%;
            height: calc(100% + var(--vscode-titlebar-offset));
            margin-top: calc(-1 * var(--vscode-titlebar-offset));
            border: none;
            background: white;
        }

        .vscode-status {
            flex: 1 1 auto;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 13px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .vscode-error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
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

        /* Dim whichever pane isn't the last-focused one so it's obvious which one keystrokes
           will land in. Driven by an explicit data attribute (see focusedKind in state) rather
           than :focus-within so the highlight survives cmd+tab away/back — xterm's hidden
           textarea blurs on window blur and doesn't reliably refocus on return, which would
           otherwise drop the indicator. */
        .pane[data-pane-focused='false'] {
            filter: brightness(0.75) saturate(0.9);
        }

        .pane-body {
            height: 100%;
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
    render({inputs, state, updateState, host, dispatch, events}) {
        const split = clampSplit(state.split);
        host.style.setProperty('--ai-grow', String(split));
        host.style.setProperty('--shell-grow', String(1 - split));

        const onDividerPointerDown = (event: PointerEvent) => {
            event.preventDefault();
            /**
             * Pointer Events unify mouse, touch, and pen so the same handler covers desktop and
             * iPad. `setPointerCapture` keeps `pointermove`/`pointerup` flowing to this element
             * even if the finger drifts off it mid-drag.
             */
            const divider = event.currentTarget;
            if (divider instanceof Element) {
                divider.setPointerCapture(event.pointerId);
            }

            // Mute selection + force resize cursor globally during drag — otherwise crossing
            // into the xterm canvas flips the cursor to i-beam and selects terminal text.
            const previousUserSelect = document.body.style.userSelect;
            const previousCursor = document.body.style.cursor;
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';

            let latestSplit = split;
            updateState({
                dragging: true,
            });

            const onMove = (moveEvent: PointerEvent) => {
                if (moveEvent.pointerId !== event.pointerId) {
                    return;
                }
                const rect = host.getBoundingClientRect();
                if (rect.width <= 0) {
                    return;
                }
                latestSplit = clampSplit((moveEvent.clientX - rect.left) / rect.width);
                updateState({
                    split: latestSplit,
                });
            };

            const onUp = (upEvent: PointerEvent) => {
                if (upEvent.pointerId !== event.pointerId) {
                    return;
                }
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
                document.body.style.userSelect = previousUserSelect;
                document.body.style.cursor = previousCursor;
                updateState({
                    dragging: false,
                });
                localStorageClient.paneSplit.write(latestSplit);
            };

            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            window.addEventListener('pointercancel', onUp);
        };

        const onDividerDoubleClick = () => {
            updateState({
                split: paneSplit.default,
            });
            localStorageClient.paneSplit.write(paneSplit.default);
        };

        /**
         * `focusin` bubbles through the shadow boundary (composed events), so xterm's hidden
         * textarea gaining focus reaches this listener via the outer `.pane` div. Default the
         * highlight to whichever pane is visible first when nothing has been focused yet, so the
         * initial render doesn't show both panes dimmed.
         */
        const focusedKind = state.focusedKind ?? (inputs.aiHidden ? PaneKind.Shell : PaneKind.Ai);
        const aiFocused = focusedKind === PaneKind.Ai;
        const shellFocused = focusedKind === PaneKind.Shell;

        /**
         * Lazy: kick off the VS Code spawn the first time the user activates the Code tab. Deferred
         * via microtask so we don't mutate state during render. Once `vscodeUrl` is set the iframe
         * stays mounted across CLI ↔ Code toggles.
         */
        if (
            inputs.codeTabActive &&
            !state.vscodeUrl &&
            !state.vscodeLoading &&
            !state.vscodeError &&
            !state.vscodeUserClosed
        ) {
            updateState({
                vscodeLoading: true,
            });
            const folder = inputs.folder;
            void ensureVscode({
                folder,
            })
                .then(({basePath}) => {
                    const url = `${agentStormService.serviceOrigin}${basePath}/?folder=${encodeURIComponent(folder)}`;
                    updateState({
                        vscodeUrl: url,
                        vscodeLoading: false,
                        vscodeError: undefined,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        vscodeLoading: false,
                        vscodeError: error instanceof Error ? error.message : String(error),
                    });
                });
        }

        const onCloseVscode = () => {
            const folder = inputs.folder;
            updateState({
                vscodeUrl: undefined,
                vscodeLoading: false,
                vscodeError: undefined,
                vscodeUserClosed: true,
            });
            void killVscode({
                folder,
            }).catch(() => {
                /* server-side cleanup is best-effort; the iframe is already gone */
            });
            /** If the user closes VS Code while looking at the Code tab, snap back to CLI. */
            if (inputs.codeTabActive) {
                dispatch(new events.cliTabRequested());
            }
        };

        return html`
            <div class="tab-bar" role="tablist">
                <button
                    type="button"
                    class="tab"
                    role="tab"
                    ?data-selected=${!inputs.codeTabActive}
                    aria-selected=${!inputs.codeTabActive}
                    ${listen('click', () => dispatch(new events.cliTabRequested()))}
                >
                    CLI
                </button>
                <button
                    type="button"
                    class="tab"
                    role="tab"
                    ?data-selected=${inputs.codeTabActive}
                    aria-selected=${inputs.codeTabActive}
                    ${listen('click', () => {
                        /**
                         * Reset the user-closed flag so the auto-ensure block fires on this Code
                         * tab activation. Without this, after closing VS Code the user would have
                         * to click Code, then click somewhere else, then click Code again to
                         * actually respawn it.
                         */
                        if (state.vscodeUserClosed) {
                            updateState({
                                vscodeUserClosed: false,
                            });
                        }
                        dispatch(new events.codeTabRequested());
                    })}
                >
                    Code
                </button>
                ${state.vscodeUrl
                    ? html`
                          <button
                              type="button"
                              class="close-vscode"
                              title="Close VS Code for this folder"
                              ${listen('click', onCloseVscode)}
                          >
                              ×
                          </button>
                      `
                    : ''}
            </div>
            <div class="body">
                ${state.vscodeUrl
                    ? html`
                          <div class="code-pane" ?data-hidden=${!inputs.codeTabActive}>
                              <iframe
                                  class="vscode-iframe"
                                  src=${state.vscodeUrl}
                                  title="VS Code"
                              ></iframe>
                          </div>
                      `
                    : inputs.codeTabActive
                      ? html`
                            <div class="vscode-status">
                                ${state.vscodeError
                                    ? html`
                                          <span class="vscode-error">
                                              VS Code failed to start: ${state.vscodeError}
                                          </span>
                                      `
                                    : 'Starting VS Code…'}
                            </div>
                        `
                      : ''}
                <div class="cli-panes" ?data-hidden=${inputs.codeTabActive}>
                    ${inputs.aiHidden
                        ? ''
                        : html`
                              <div
                                  class="pane ai-pane"
                                  data-pane-focused=${aiFocused ? 'true' : 'false'}
                                  ${listen('focusin', () =>
                                      updateState({
                                          focusedKind: PaneKind.Ai,
                                      }),
                                  )}
                              >
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
                                  ${listen('pointerdown', onDividerPointerDown)}
                                  ${listen('dblclick', onDividerDoubleClick)}
                              ></div>
                          `}
                    <div
                        class="pane shell-pane"
                        data-pane-focused=${shellFocused ? 'true' : 'false'}
                        ${listen('focusin', () =>
                            updateState({
                                focusedKind: PaneKind.Shell,
                            }),
                        )}
                    >
                        <div class="pane-body">
                            <${VirTerminal.assign({
                                folder: inputs.folder,
                                kind: PaneKind.Shell,
                                active: inputs.active,
                            })}></${VirTerminal}>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },
});
