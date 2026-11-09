import {type PaneKind} from '@agent-storm/common';
import {defineAppElement, isDarkMode} from '@agent-storm/core/frontend';
import {type Terminal} from '@xterm/xterm';
import {css, html, listen, nothing, onDomCreated, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {reportDropError} from './terminal-drop.js';
import {connectTerminalSession} from './terminal-session.js';
import {terminalThemes} from './terminal-theme.js';
import {VirTerminalAccessoryBar} from './vir-terminal-accessory-bar.element.js';
import {defaultXtermStyles} from './xterm-styles.js';

export {toControlByte} from './terminal-session.js';

/** Prompt-based paste fallback. The native prompt field is editable, so the OS paste menu works. */
function promptPaste(terminal: Terminal): void {
    const text = window.prompt('Paste into terminal:');
    if (text) {
        terminal.paste(text);
    }
}

/**
 * Paste clipboard contents into the terminal — needed on mobile, where there's no Ctrl/Cmd+V and no
 * editable element for the OS paste menu to target. Routes through `terminal.paste` so bracketed
 * paste mode is honored. The async Clipboard API only exists in a secure context (HTTPS/localhost);
 * agent-storm's dev server is plain HTTP over LAN, so when it's unavailable (or denied) we fall
 * back to a native `prompt`, which the user can paste into via the OS menu on any context.
 */
export async function pasteIntoTerminal(terminal: Terminal) {
    /**
     * `navigator.clipboard` only exists in a secure context; the DOM types don't model that, so
     * gate on `isSecureContext` rather than a (lint-flagged) truthiness check on the clipboard
     * object.
     */
    if (!window.isSecureContext) {
        promptPaste(terminal);
        return;
    }
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            terminal.paste(text);
        } else {
            promptPaste(terminal);
        }
    } catch {
        promptPaste(terminal);
    }
}

export const VirTerminal = defineAppElement<{
    folder: string;
    kind: PaneKind;
    /**
     * Which session tab within `folder` + `kind` this terminal is attached to. Baked into the
     * `/pty` search params when the socket opens, so switching sessions must mount a _new_ element
     * rather than re-assign this input — the `onDomCreated` hook below doesn't re-run on input
     * changes. `vir-pane-group` guarantees that by keying its `repeat` on the session id.
     */
    sessionId: string;
    /**
     * True when this terminal's pane is the user's currently active folder. Used to re-fit and push
     * a fresh size to the server on the false→true transition: a CSS-hidden pane reports a 0×0
     * content rect and won't have observed live window-resize events, so its server-side dimensions
     * may be stale by the time the user clicks back in.
     */
    active: boolean;
    /**
     * Render the touch accessory key bar (Ctrl / Esc / arrows / Tab) pinned above the soft
     * keyboard. Passed `true` only on mobile, where there's no hardware keyboard to produce those
     * keys.
     */
    showAccessoryKeys: boolean;
    /** Take keyboard focus as soon as the terminal opens. Read once, when the element mounts. */
    focusOnMount: boolean;
    /**
     * Whether this terminal's tab is shown in the pane group the user last focused. Unfocused
     * terminals dim, so it's clear which one keystrokes go to. Passed in rather than read from
     * :focus-within because xterm's hidden textarea blurs on window blur and doesn't reliably
     * refocus on return.
     */
    isFocused: boolean;
}>()({
    tagName: 'vir-terminal',
    state() {
        return {
            terminal: undefined as Terminal | undefined,
            resizeObserver: undefined as ResizeObserver | undefined,
            disconnect: undefined as (() => void) | undefined,
            /**
             * Set once the terminal+socket finish initializing. Invoking it re-runs
             * `fitAddon.fit()` and pushes the new cols/rows to the server so a previously-hidden
             * pane catches up to the current viewport when it becomes visible.
             */
            onActivate: undefined as (() => void) | undefined,
            wasActive: false,
            uploadError: undefined as string | undefined,
            uploadErrorTimeout: undefined as ReturnType<typeof setTimeout> | undefined,
            /**
             * Whether the sticky Ctrl modifier is currently armed (drives the button's active
             * style).
             */
            ctrlArmed: false,
            /**
             * Send raw bytes to the pty. Set once the socket connects; undefined drives a disabled
             * bar.
             */
            sendBytes: undefined as ((bytes: string) => void) | undefined,
            /** Toggle the sticky Ctrl modifier on/off. Set once the socket connects. */
            toggleCtrl: undefined as (() => void) | undefined,
            /**
             * Flipped by `cleanup` so the async setup below can tell it was unmounted mid-flight.
             * Setup awaits font loading, config, the auth secret, and the WebSocket handshake
             * before it has anything to store in `disconnect` — without this flag, an element torn
             * down during that window leaves a socket open with nothing holding a reference to
             * close it. Switching session tabs makes that window routine rather than rare.
             */
            unmounted: false,
            /** Mirrors {@link isDarkMode} so the host background can follow xterm's palette. */
            useDarkTheme: isDarkMode(),
            /** Unsubscribes this terminal from theme changes. Set once the terminal is created. */
            stopThemeListener: undefined as (() => void) | undefined,
        };
    },
    hostClasses: {
        'vir-terminal-dark'({state}) {
            return state.useDarkTheme;
        },
        'vir-terminal-unfocused'({inputs}) {
            return !inputs.isFocused;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                flex-direction: column;
                position: relative;
                width: 100%;
                height: 100%;
                box-sizing: border-box;
                transition: filter 120ms ease;
                /* Matches xterm's own background so the strip left over when the terminal doesn't
               divide evenly into cells doesn't show a different color than the cells above it. */
                background: ${unsafeCSS(terminalThemes.light.background || 'transparent')};
            }

            ${hostClasses['vir-terminal-dark'].selector} {
                background: ${unsafeCSS(terminalThemes.dark.background || 'transparent')};
            }

            ${hostClasses['vir-terminal-unfocused'].selector} {
                filter: brightness(0.75) saturate(0.9);
            }

            .terminal-host {
                width: 100%;
                /* Fill the column above the accessory bar. min-height: 0 lets the flex item shrink below
               its content height so xterm can fit to whatever space is left. */
                flex-grow: 1;
                flex-shrink: 1;
                min-height: 0;
                /* We translate touch drags into terminal.scrollLines ourselves, so tell iOS to keep
               its hands off the gesture entirely. pan-y would still let the browser try a
               vertical pan — when xterm has nothing more to scroll, that pan chains up to the page
               and triggers the rubber-band / scroll-past behavior. none blocks that and also
               disables iOS double-tap zoom on the canvas. */
                touch-action: none;
                overscroll-behavior: contain;
            }

            ${defaultXtermStyles}

            /* xterm.css sets cursor: default on the viewport, which sits on top of the canvas, AND
           the WebGL renderer addon adds extra canvas / link layers with their own cursor styles
           — so as the pointer hits different child elements in the same pixel area, the cursor
           flickers between i-beam and default every frame. Force i-beam everywhere inside the
           terminal via a descendant rule so no inner layer can override it. */
        .xterm,
        .xterm * {
                cursor: text;
            }

            ${hostClasses['vir-terminal-unfocused'].selector} .xterm,
            ${hostClasses['vir-terminal-unfocused'].selector} .xterm * {
                cursor: default;
            }

            .upload-error {
                position: absolute;
                top: 8px;
                right: 8px;
                max-width: 70%;
                padding: 6px 10px;
                border-radius: 6px;
                font-size: 12px;
                color: ${viraThemeByKeys.red.foreground.body.foreground.value};
                background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
                border: 1px solid ${viraThemeByKeys.red.foreground.decoration.foreground.value};
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                pointer-events: none;
                white-space: pre-wrap;
            }
        `;
    },
    cleanup({state, updateState}) {
        updateState({
            unmounted: true,
        });
        state.resizeObserver?.disconnect();
        state.stopThemeListener?.();
        state.disconnect?.();
        state.terminal?.dispose();
        if (state.uploadErrorTimeout) {
            clearTimeout(state.uploadErrorTimeout);
        }
    },
    render({inputs, state, updateState}) {
        /**
         * Fire fit-and-resend on the false→true active transition. A pane that was `display: none`
         * while the user resized the window won't have observed live `ResizeObserver` entries; this
         * catches up the moment it becomes visible. `requestAnimationFrame` defers the call until
         * after the CSS flip has landed so `fitAddon.fit()` sees the post-activation host rect
         * instead of 0×0.
         *
         * Even when the post-activation dims happen to match the last-sent ones (so the pty resize
         * is a no-op), the TUI app in the pty — Claude in particular — may have an alt-screen
         * buffer drawn at a stale width that needs a fresh `SIGWINCH` to redraw.
         * `socket.send({redraw: true})` makes the daemon kick that signal regardless of dims.
         */
        if (inputs.active && !state.wasActive) {
            updateState({
                wasActive: true,
            });
            const onActivate = state.onActivate;
            if (onActivate) {
                requestAnimationFrame(onActivate);
            }
        } else if (!inputs.active && state.wasActive) {
            updateState({
                wasActive: false,
            });
        }
        return html`
            ${state.uploadError
                ? html`
                      <div class="upload-error" role="alert">${state.uploadError}</div>
                  `
                : nothing}
            <div
                class="terminal-host"
                ${onDomCreated(async (createdElement) => {
                    if (state.terminal || !(createdElement instanceof HTMLElement)) {
                        return;
                    }
                    const session = await connectTerminalSession({
                        element: createdElement,
                        inputs,
                        isUnmounted() {
                            return state.unmounted;
                        },
                        onCtrlArmedChange(isArmed) {
                            updateState({
                                ctrlArmed: isArmed,
                            });
                        },
                        onDarkThemeChange(isDark) {
                            updateState({
                                useDarkTheme: isDark,
                            });
                        },
                        reportError(message) {
                            reportDropError(updateState, state, message);
                        },
                    });
                    if (session) {
                        updateState(session);
                    }
                })}
            ></div>
            ${inputs.showAccessoryKeys && state.sendBytes && state.toggleCtrl
                ? html`
                      <${VirTerminalAccessoryBar.assign({
                          ctrlArmed: state.ctrlArmed,
                      })}
                          ${listen(VirTerminalAccessoryBar.events.keyPress, (event) => {
                              state.sendBytes?.(
                                  state.terminal?.modes.applicationCursorKeysMode
                                      ? event.detail.applicationBytes || event.detail.bytes
                                      : event.detail.bytes,
                              );
                          })}
                          ${listen(VirTerminalAccessoryBar.events.ctrlToggle, () => {
                              state.toggleCtrl?.();
                          })}
                          ${listen(VirTerminalAccessoryBar.events.pasteRequest, async () => {
                              if (state.terminal) {
                                  await pasteIntoTerminal(state.terminal);
                              }
                          })}
                      ></${VirTerminalAccessoryBar}>
                  `
                : nothing}
        `;
    },
});
