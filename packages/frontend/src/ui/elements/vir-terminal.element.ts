import {agentStormService, PaneKind} from '@agent-storm/common';
import {connectWebSocket} from '@rest-vir/define-service';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {WebglAddon} from '@xterm/addon-webgl';
import {Terminal, type ITheme} from '@xterm/xterm';
import {css, defineElement, html, onDomCreated, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {getConfig, uploadFile} from '../../util/api-client.js';
import {ensureSecret} from '../../util/auth.js';
import {defaultXtermStyles} from './xterm-styles.js';

const uploadErrorDismissMs = 5000;

function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                reject(new Error('FileReader produced non-string result.'));
                return;
            }
            // result is a data URL of the form `data:<mime>;base64,<payload>`.
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        });
        reader.addEventListener('error', () =>
            reject(reader.error ?? new Error('FileReader failed.')),
        );
        reader.readAsDataURL(file);
    });
}

async function uploadDroppedFiles(files: ReadonlyArray<File>): Promise<string[]> {
    return await Promise.all(
        files.map(async (file) => {
            const dataBase64 = await fileToBase64(file);
            return await uploadFile({
                filename: file.name || 'upload',
                dataBase64,
            });
        }),
    );
}

/**
 * Browsers don't agree on whether dragged files land in `dataTransfer.files` or
 * `dataTransfer.items`. The macOS screenshot-thumbnail drag in particular tends to surface the file
 * only through `items` (kind === 'file'). Collect from both, dedupe by reference.
 */
function collectDroppedFiles(transfer: DataTransfer): File[] {
    const seen = new Set<File>();
    Array.from(transfer.files).forEach((file) => seen.add(file));
    Array.from(transfer.items).forEach((item) => {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                seen.add(file);
            }
        }
    });
    return Array.from(seen);
}

type UploadErrorState = {
    uploadError: string | undefined;
    uploadErrorTimeout: ReturnType<typeof setTimeout> | undefined;
};

type UploadErrorUpdate = (newState: Partial<UploadErrorState>) => void;

function reportDropError(
    updateState: UploadErrorUpdate,
    state: Readonly<UploadErrorState>,
    message: string,
): void {
    if (state.uploadErrorTimeout) {
        clearTimeout(state.uploadErrorTimeout);
    }
    const uploadErrorTimeout = setTimeout(() => {
        updateState({
            uploadError: undefined,
            uploadErrorTimeout: undefined,
        });
    }, uploadErrorDismissMs);
    updateState({
        uploadError: message,
        uploadErrorTimeout,
    });
}

/**
 * Extracted from Terminal.app's `vir-light` profile via the bundled `extract-terminal-theme.swift`
 * helper. Slots that the plist omits (because they match Terminal.app's built-in defaults) are
 * filled in here so xterm renders the full 16-color palette.
 */
function decodeFileUri(uri: string): string {
    const withoutScheme = uri.replace(/^file:\/\/(localhost)?/, '');
    return decodeURIComponent(withoutScheme);
}

/** POSIX-quote a string so a shell receives it verbatim, spaces and all. */
function shellQuote(input: string): string {
    if (/^[\w@%+=:,./-]+$/.test(input)) {
        return input;
    }
    const escaped = input.replace(/'/g, String.raw`'\''`);
    return `'${escaped}'`;
}

function extractDroppedPaths(transfer: DataTransfer): string[] {
    const uriList = transfer.getData('text/uri-list');
    if (uriList) {
        return uriList
            .split(/\r?\n/)
            .filter((line) => line && !line.startsWith('#'))
            .map((line) => (line.startsWith('file:') ? decodeFileUri(line) : line));
    }
    const plain = transfer.getData('text/plain');
    if (plain) {
        return plain.split(/\r?\n/).filter((line) => line);
    }
    return [];
}

const terminalAppTheme: ITheme = {
    background: '#ffffff',
    foreground: '#0220b3',
    cursor: '#ff2600',
    cursorAccent: '#ffffff',
    /**
     * Xterm pre-blends `selectionBackground` against the terminal-level background once at theme
     * load and paints the result as an opaque rectangle over the cells; it does not invert or
     * alpha-composite per cell at draw time (that's an xterm renderer limitation).
     */
    selectionBackground: 'rgba(56, 213, 255, 0.18)',
    black: '#000000',
    red: '#990000',
    green: '#009400',
    yellow: '#737300',
    blue: '#0038ee',
    magenta: '#b300b3',
    cyan: '#007f89',
    white: '#818181',
    brightBlack: '#666666',
    brightRed: '#ff0004',
    brightGreen: '#00bb0f',
    brightYellow: '#a5a500',
    brightBlue: '#0064ff',
    brightMagenta: '#e500e5',
    brightCyan: '#2799bb',
    brightWhite: '#bababa',
};

export const VirTerminal = defineElement<{
    folder: string;
    kind: PaneKind;
    /**
     * True when this terminal's pane is the user's currently active folder. Used to re-fit and push
     * a fresh size to the server on the false→true transition: a CSS-hidden pane reports a 0×0
     * content rect and won't have observed live window-resize events, so its server-side dimensions
     * may be stale by the time the user clicks back in.
     */
    active: boolean;
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
        };
    },
    styles: css`
        :host {
            display: block;
            position: relative;
            width: 100%;
            height: 100%;
            box-sizing: border-box;
            padding: 2px;
            background: ${unsafeCSS(terminalAppTheme.background || 'transparent')};
        }

        .terminal-host {
            width: 100%;
            height: 100%;
            /* We translate touch drags into terminal.scrollLines ourselves, so tell iOS to keep
               its hands off the gesture entirely. pan-y would still let the browser try a
               vertical pan — when xterm has nothing more to scroll, that pan chains up to the page
               and triggers the rubber-band / scroll-past behavior. none blocks that and also
               disables iOS double-tap zoom on the canvas. */
            touch-action: none;
            overscroll-behavior: contain;
        }

        ${defaultXtermStyles}

        /* xterm.css sets cursor: default on the viewport, which sits on top of the canvas.
           We want the classic terminal i-beam everywhere the user can click. */
        .xterm,
        .xterm .xterm-viewport,
        .xterm .xterm-screen {
            cursor: text;
        }

        .upload-error {
            position: absolute;
            top: 8px;
            right: 8px;
            max-width: 70%;
            padding: 6px 10px;
            border-radius: 6px;
            font-family: ui-sans-serif, system-ui, sans-serif;
            font-size: 12px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
            border: 1px solid ${viraThemeByKeys.red.foreground.decoration.foreground.value};
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            pointer-events: none;
            white-space: pre-wrap;
        }
    `,
    cleanup({state}) {
        state.resizeObserver?.disconnect();
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
                : ''}
            <div
                class="terminal-host"
                ${onDomCreated(async (element) => {
                    if (state.terminal || !(element instanceof HTMLElement)) {
                        return;
                    }

                    // Wait for the bundled MesloLGS NF to load before xterm measures cell
                    // widths against the fallback (Menlo) and ends up with wrong column metrics.
                    // Fetch config in parallel so the WebGL toggle is ready by the time we need it.
                    const [
                        ,
                        ,
                        ,
                        config,
                    ] = await Promise.all([
                        document.fonts.load('13px "MesloLGS NF"').catch(() => undefined),
                        document.fonts.load('bold 13px "MesloLGS NF"').catch(() => undefined),
                        document.fonts.load('italic 13px "MesloLGS NF"').catch(() => undefined),
                        // If the config fetch fails (e.g. server briefly unreachable), default
                        // to WebGL on — matches the optionalShape default and pre-toggle behavior.
                        getConfig().catch(() => undefined),
                    ]);
                    // optionalShape default is true; treat undefined as on.
                    const useWebgl = config?.useWebgl !== false;

                    const terminal = new Terminal({
                        fontFamily: '"MesloLGS NF", Menlo, monospace',
                        fontSize: 13,
                        cursorBlink: true,
                        cursorStyle: 'bar',
                        cursorWidth: 3,
                        theme: terminalAppTheme,
                    });
                    const fitAddon = new FitAddon();
                    terminal.loadAddon(fitAddon);
                    terminal.loadAddon(new WebLinksAddon());
                    terminal.open(element);

                    /**
                     * WebGL must be attached after `open()` because it needs the DOM-mounted
                     * canvases to bind to. On a context loss (tab send to the background long
                     * enough for the browser to reclaim the GPU context, driver crash, etc.) we
                     * dispose the addon and let xterm fall through to its DOM renderer rather than
                     * leave the terminal blank. WebGL construction itself can throw on machines
                     * without WebGL2 — wrap it so those users also fall through to DOM rather than
                     * getting a blank pane.
                     *
                     * Toggleable via the settings modal; the preference is read once at terminal
                     * construction, so the modal reloads the page after a change to apply it.
                     */
                    if (useWebgl) {
                        try {
                            const webglAddon = new WebglAddon();
                            webglAddon.onContextLoss(() => {
                                webglAddon.dispose();
                            });
                            terminal.loadAddon(webglAddon);
                        } catch (error) {
                            console.warn(
                                'xterm WebGL renderer unavailable, falling back to DOM',
                                error,
                            );
                        }
                    }

                    fitAddon.fit();

                    const secret = await ensureSecret();
                    const socket = await connectWebSocket(agentStormService.webSockets['/pty'], {
                        searchParams: {
                            folder: [inputs.folder],
                            kind: [inputs.kind],
                        },
                        protocols: [secret],
                        listeners: {
                            message({message}) {
                                terminal.write(message);
                            },
                            close() {
                                terminal.write('\r\n[connection closed]\r\n');
                            },
                        },
                    });

                    const sendResize = () => {
                        socket.send({
                            resize: {
                                cols: terminal.cols,
                                rows: terminal.rows,
                            },
                        });
                    };

                    sendResize();

                    terminal.onData((data) => {
                        socket.send(data);
                    });

                    /**
                     * Shell (bash/zsh readline) and the AI TUI (Claude / Ink) interpret the same
                     * key event differently:
                     *
                     * - Claude / Ink-based TUIs understand the xterm "modified arrow" CSI form
                     *   `\x1b[1;3D` / `\x1b[1;3C` — that's the "Alt+ArrowLeft / ArrowRight" the
                     *   library expects.
                     * - Readline (the line editor inside bash and zsh) does NOT bind that form by
                     *   default — it binds the canonical Meta-letter sequences `\eb`
                     *   (backward-word) and `\ef` (forward-word). When the shell receives
                     *   `\x1b[1;3D` it parses the CSI prefix, finds no binding for the modified
                     *   arrow, and the trailing `D` / `C` falls through as a literal character
                     *   (visible as the user types).
                     *
                     * So pick the form per pane kind. Backspace shortcuts are the same in both
                     * because the control bytes they emit (\x15 backward-kill-line, \x17
                     * backward-kill-word, \x01 home, \x05 end) are universally understood.
                     */
                    const isAiPane = inputs.kind === PaneKind.Ai;
                    const keyBindings: Record<string, string> = {
                        'meta+Backspace': '\x15',
                        'alt+Backspace': '\x17',
                        'meta+ArrowLeft': '\x01',
                        'meta+ArrowRight': '\x05',
                        'alt+ArrowLeft': isAiPane ? '\x1b[1;3D' : '\x1bb',
                        'alt+ArrowRight': isAiPane ? '\x1b[1;3C' : '\x1bf',
                    };

                    terminal.attachCustomKeyEventHandler((event) => {
                        if (event.type !== 'keydown') {
                            return true;
                        }
                        const modifier = event.metaKey ? 'meta' : event.altKey ? 'alt' : '';
                        const bytes = keyBindings[`${modifier}+${event.key}`];
                        if (bytes) {
                            socket.send(bytes);
                            event.preventDefault();
                            return false;
                        }
                        return true;
                    });

                    /**
                     * IPad touch-drag scrolling. xterm's WebGL canvas captures touch events and its
                     * own viewport-scroll behavior doesn't kick in on touch, so the terminal
                     * scrollback is unreachable on iOS without this. Translate a one-finger drag
                     * into `terminal.scrollLines` calls, sized against the actual rendered row
                     * height when we can read it (falls back to the configured font size with
                     * xterm's 1.2 line-height multiplier).
                     */
                    const touchScrollState: {
                        pointerId: number | undefined;
                        lastY: number;
                    } = {
                        pointerId: undefined,
                        lastY: 0,
                    };
                    element.addEventListener(
                        'pointerdown',
                        (event) => {
                            if (event.pointerType !== 'touch') {
                                return;
                            }
                            touchScrollState.pointerId = event.pointerId;
                            touchScrollState.lastY = event.clientY;
                        },
                        {
                            passive: true,
                        },
                    );
                    element.addEventListener(
                        'pointermove',
                        (event) => {
                            if (
                                event.pointerType !== 'touch' ||
                                event.pointerId !== touchScrollState.pointerId
                            ) {
                                return;
                            }
                            const rowsEl = element.querySelector('.xterm-rows');
                            const sampleRow = rowsEl?.firstElementChild;
                            const rowHeight =
                                sampleRow instanceof HTMLElement
                                    ? sampleRow.getBoundingClientRect().height || 0
                                    : 0;
                            const effectiveRowHeight =
                                rowHeight > 0 ? rowHeight : (terminal.options.fontSize ?? 13 * 1.2);
                            const deltaY = event.clientY - touchScrollState.lastY;
                            const lines = Math.trunc(-deltaY / effectiveRowHeight);
                            if (lines !== 0) {
                                terminal.scrollLines(lines);
                                touchScrollState.lastY -= lines * effectiveRowHeight;
                            }
                        },
                        {
                            passive: true,
                        },
                    );
                    const endTouchScroll = (event: PointerEvent) => {
                        if (event.pointerId === touchScrollState.pointerId) {
                            touchScrollState.pointerId = undefined;
                        }
                    };
                    element.addEventListener('pointerup', endTouchScroll, {
                        passive: true,
                    });
                    element.addEventListener('pointercancel', endTouchScroll, {
                        passive: true,
                    });

                    element.addEventListener('dragover', (event) => {
                        // dragover must be handled (preventDefault'd) for the matching drop event
                        // to fire on a non-form element.
                        event.preventDefault();
                        if (event.dataTransfer) {
                            event.dataTransfer.dropEffect = 'copy';
                        }
                    });
                    element.addEventListener('drop', (event) => {
                        event.preventDefault();
                        if (!event.dataTransfer) {
                            return;
                        }
                        // `text/uri-list` gives us real on-disk paths from Finder; prefer it.
                        const paths = extractDroppedPaths(event.dataTransfer);
                        if (paths.length > 0) {
                            socket.send(paths.map(shellQuote).join(' '));
                            return;
                        }
                        // No URI list: this is an in-memory blob (screenshot, dragged image from
                        // a webpage, etc.). The browser sometimes exposes those via
                        // `dataTransfer.files`, sometimes only via `dataTransfer.items` with
                        // kind === 'file'. Collect from both and dedupe.
                        const files = collectDroppedFiles(event.dataTransfer);
                        if (files.length === 0) {
                            reportDropError(
                                updateState,
                                state,
                                'Drop carried no file or path the browser would expose.',
                            );
                            return;
                        }
                        void uploadDroppedFiles(files)
                            .then((uploadedPaths) => {
                                socket.send(uploadedPaths.map(shellQuote).join(' '));
                            })
                            .catch((error: unknown) => {
                                const message =
                                    error instanceof Error ? error.message : String(error);

                                console.error('agent-storm upload failed:', error);
                                reportDropError(updateState, state, `Upload failed: ${message}`);
                            });
                    });

                    // Intercept image pastes (Cmd+V after a screenshot) before xterm's textarea
                    // sees them. Plain-text pastes fall through to xterm's default handler.
                    // Capture phase so we run before the textarea's own paste handler can fire.
                    element.addEventListener(
                        'paste',
                        (event) => {
                            if (!event.clipboardData) {
                                return;
                            }
                            const imageFiles = Array.from(event.clipboardData.items)
                                .filter(
                                    (item) =>
                                        item.kind === 'file' && item.type.startsWith('image/'),
                                )
                                .map((item) => item.getAsFile())
                                .filter((file): file is File => !!file);
                            if (imageFiles.length === 0) {
                                return;
                            }
                            event.preventDefault();
                            event.stopImmediatePropagation();
                            void uploadDroppedFiles(imageFiles)
                                .then((uploadedPaths) => {
                                    socket.send(uploadedPaths.map(shellQuote).join(' '));
                                })
                                .catch((error: unknown) => {
                                    const message =
                                        error instanceof Error ? error.message : String(error);

                                    console.error('agent-storm paste upload failed:', error);
                                    reportDropError(updateState, state, `Paste failed: ${message}`);
                                });
                        },
                        true,
                    );

                    const fitAndResend = () => {
                        /**
                         * Bail when the host has no real layout — the pane is `display: none`
                         * because the user switched to a different folder. If we fit anyway,
                         * `fitAddon.fit()` shrinks xterm to a minimum cols, then `sendResize`
                         * pushes those tiny dims to the pty, Claude redraws at the tiny width, and
                         * that narrow rendering goes into xterm's scrollback permanently — visible
                         * the next time the user returns to this folder. When the pane becomes
                         * visible again, `ResizeObserver` will fire another entry with real dims
                         * and we'll catch up then.
                         */
                        if (element.offsetWidth < 10 || element.offsetHeight < 10) {
                            return;
                        }
                        fitAddon.fit();
                        sendResize();
                    };

                    const resizeObserver = new ResizeObserver(fitAndResend);
                    resizeObserver.observe(element);

                    /**
                     * Activation handler: just re-fit and push dims. We tried adding a force-
                     * SIGWINCH on top of this to coax TUIs (Claude) into re-rendering stale
                     * scrollback at the new width, but every approach produced visual artifacts —
                     * the pty and xterm went out of sync mid-redraw and Claude's UI shredded
                     * itself. So this is back to a plain "make sure dims match" on activation; any
                     * stale alt-screen content the user wants reflowed can be cleared with Claude's
                     * own Ctrl+L.
                     */
                    const onActivate = fitAndResend;

                    updateState({
                        terminal,
                        resizeObserver,
                        onActivate,
                        disconnect: () => {
                            void socket.close();
                        },
                    });
                })}
            ></div>
        `;
    },
});
