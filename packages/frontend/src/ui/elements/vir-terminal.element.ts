import {agentStormService, PaneKind} from '@agent-storm/common';
import {connectWebSocket} from '@rest-vir/define-service';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {WebglAddon} from '@xterm/addon-webgl';
import {Terminal, type ITheme} from '@xterm/xterm';
import {css, defineElement, html, listen, onDomCreated, unsafeCSS} from 'element-vir';
import {createSizedIcon, lucideIcons, ViraIcon, viraThemeByKeys} from 'vira';
import {getConfig, uploadFile} from '../../util/api-client.js';
import {ensureSecret} from '../../util/auth.js';
import {defaultXtermStyles} from './xterm-styles.js';

const uploadErrorDismissMs = 5000;
const terminalScrollbackLines = 20_000;

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

/**
 * Convert a typed character to the control byte a physical Ctrl+<key> would emit: the terminal
 * convention is `byte & 0x1f`, so Ctrl+C → `\x03`, Ctrl+D → `\x04`, Ctrl+L → `\x0c`, etc. Used by
 * the mobile accessory bar's sticky Ctrl, where there's no hardware Ctrl key to hold.
 */
export function toControlByte(input: string): string {
    return String.fromCodePoint((input.toUpperCase().codePointAt(0) ?? 0) & 0x1f);
}

const clipboardIcon = createSizedIcon(lucideIcons.Clipboard, 18);

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
export function pasteIntoTerminal(terminal: Terminal): void {
    /**
     * `navigator.clipboard` only exists in a secure context; the DOM types don't model that, so
     * gate on `isSecureContext` rather than a (lint-flagged) truthiness check on the clipboard
     * object.
     */
    if (!window.isSecureContext) {
        promptPaste(terminal);
        return;
    }
    void navigator.clipboard
        .readText()
        .then((text) => {
            if (text) {
                terminal.paste(text);
            } else {
                promptPaste(terminal);
            }
        })
        .catch(() => promptPaste(terminal));
}

/**
 * Mobile accessory keys that fire a single sequence per tap (no sticky toggle). The bytes are the
 * exact escape sequences xterm would send for the corresponding physical key, so the pty / TUI
 * can't tell the difference between these and a hardware keyboard.
 */
const accessoryKeys: ReadonlyArray<{
    label: string;
    title: string;
    bytes: string;
}> = [
    {
        label: 'esc',
        title: 'Escape',
        bytes: '\x1b',
    },
    {
        label: '←',
        title: 'Left arrow',
        bytes: '\x1b[D',
    },
    {
        label: '↑',
        title: 'Up arrow',
        bytes: '\x1b[A',
    },
    {
        label: '↓',
        title: 'Down arrow',
        bytes: '\x1b[B',
    },
    {
        label: '→',
        title: 'Right arrow',
        bytes: '\x1b[C',
    },
    {
        label: 'tab',
        title: 'Tab',
        bytes: '\t',
    },
];

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
    /**
     * Render the touch accessory key bar (Ctrl / Esc / arrows / Tab) pinned above the soft
     * keyboard. Passed `true` only on mobile, where there's no hardware keyboard to produce those
     * keys.
     */
    showAccessoryKeys: boolean;
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
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            position: relative;
            width: 100%;
            height: 100%;
            box-sizing: border-box;
            background: ${unsafeCSS(terminalAppTheme.background || 'transparent')};
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

        /* Touch accessory key bar. In normal flow as the last flex-column child so it can't overlap
           the terminal. vir-app already shrinks the whole app to the keyboard-free area (its
           --app-viewport-height tracks window.visualViewport), so this just sits at the bottom of
           the visible pane — above the keyboard — with no positioning math of its own. Colors follow
           this element's hardcoded Terminal.app vir-light palette. */
        .accessory-bar {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            gap: 6px;
            padding: 6px;
            box-sizing: border-box;
            background: #e9e9ef;
            border-top: 1px solid #c8c8d2;
            /* Sit inside the iPhone home-indicator safe area when the keyboard is closed. */
            padding-bottom: max(6px, env(safe-area-inset-bottom));

            .accessory-key {
                display: flex;
                align-items: center;
                justify-content: center;
                flex-grow: 1;
                flex-shrink: 1;
                min-width: 0;
                min-height: 40px;
                padding: 0 4px;
                border: 1px solid #c8c8d2;
                border-radius: 6px;
                font-family: ui-sans-serif, system-ui, sans-serif;
                font-size: 16px;
                color: #0220b3;
                background: #ffffff;
                cursor: pointer;
                touch-action: manipulation;
                user-select: none;

                &:active {
                    background: #d7d7e0;
                }

                &[data-armed] {
                    color: #ffffff;
                    background: #0038ee;
                    border-color: #0038ee;
                }
            }
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
                    const clickableLinks = config?.terminalClickableLinks !== false;

                    const terminal = new Terminal({
                        fontFamily: '"MesloLGS NF", Menlo, monospace',
                        fontSize: 13,
                        cursorBlink: true,
                        cursorStyle: 'bar',
                        cursorWidth: 3,
                        scrollback: terminalScrollbackLines,
                        theme: terminalAppTheme,
                        /**
                         * Seed xterm with the daemon's spawn-default dims (see `pty-pool.ts`'s
                         * `spawn({cols: 120, rows: 32})`). Until `fitAndResend` runs successfully —
                         * which it can't do while this pane is mounted `display: none` for a
                         * not-yet-active folder — xterm renders any scrollback the daemon replays
                         * at these dims. Matching the pty default means lines wrap consistently;
                         * the alternative (xterm's own 80×24 default) would mis-wrap the replay
                         * against a pty that's running at 120 cols.
                         */
                        cols: 120,
                        rows: 32,
                        /**
                         * Characters that break a word for double-click selection. xterm's default
                         * (' ()[]{}',:;`) only includes whitespace + a handful of punctuation, so
                         * something like `src/foo.element.test.ts` selects as one big "word". Add
                         * structural delimiters like path separators, comparison ops, backticks,
                         * and hashes, while keeping dotted filenames together.
                         */
                        wordSeparator: ' \t\n()[]{}\'",:;/\\<>`=-#*',
                    });
                    const fitAddon = new FitAddon();
                    terminal.loadAddon(fitAddon);
                    /**
                     * `WebLinksAddon` is what makes URLs in terminal output ctrl-clickable /
                     * tappable and opens them in a new tab. Gated behind `terminalClickableLinks`
                     * so users on touch devices (where accidental taps fire links) or those who
                     * never want auto- opening can disable it via the settings modal.
                     */
                    if (clickableLinks) {
                        terminal.loadAddon(new WebLinksAddon());
                    }
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

                    /**
                     * Intentionally skip the eager `fitAddon.fit()` here. If this terminal is
                     * mounting inside a `display: none` pane-slot (a folder the user added to
                     * `openedFolders` but hasn't activated), the host's content rect is 0×0 and
                     * `fit()` would shrink xterm to its minimum (cols ≈ 1–2). The subsequent
                     * `sendResize` would then push those tiny dims to the daemon, the pty would
                     * resize to match, and any pty output produced before the pane became visible
                     * would be wrapped — and any TUI redrawn — at a degenerate width that ends up
                     * permanently in the scrollback. `fitAndResend()` (called below once it's
                     * defined, and bound to the ResizeObserver + onActivate path) carries the `<
                     * 10px` guard that suppresses exactly this case.
                     */

                    /**
                     * Silently swallow color/palette queries (OSC 10 / 11 / 12 / 4 with `?` arg).
                     * Some tools — starship, neovim, claude's status renderer, etc. — ask the
                     * terminal for its current fg / bg / cursor color so they can color-match. The
                     * terminal's response is supposed to be consumed by the asker, but if the asker
                     * exits before reading stdin (or never bothers), the response leaks into the
                     * shell at the next prompt as visible gibberish like `11;rgb:ffff/ffff/fff6`.
                     * agent-storm's theme is fully controlled here, so the shell never actually
                     * needs these responses. Return `true` from the OSC handler to mark the query
                     * as consumed; xterm skips its default response. `set` forms (no `?`) still
                     * fall through to the default handler so apps that legitimately want to change
                     * palette colors can.
                     */
                    const swallowColorQuery = (data: string): boolean => data.startsWith('?');
                    [
                        10,
                        11,
                        12,
                        4,
                    ].forEach((code) => {
                        terminal.parser.registerOscHandler(code, swallowColorQuery);
                    });

                    /**
                     * Same leak shape as the OSC color queries above, but for Device Status Report
                     * (`CSI Ps n`). zsh's interactive startup, prompt plugins (starship, p10k), and
                     * various TUIs query the cursor position with `CSI 6 n` and expect xterm to
                     * reply via `terminal.onData` with `CSI <row>;<col> R`. That reply is forwarded
                     * to the pty as if the user typed it, and any chunk of it the asker doesn't
                     * drain before the next process starts reading stdin shows up as visible
                     * gibberish like `9;1R` (the CSI prefix gets eaten by the shell's keymap and
                     * the row/col/R suffix prints verbatim). The pane has well-defined dimensions
                     * already, so no app actually needs this answer to be routed through the pty.
                     * Returning `true` consumes the query and suppresses xterm's default reply.
                     */
                    terminal.parser.registerCsiHandler(
                        {
                            final: 'n',
                        },
                        () => true,
                    );

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

                    /**
                     * Sticky Ctrl state for the mobile accessory bar. Kept as a closure object
                     * (mirrored into element state for the button's active style) so the `onData`
                     * handler below always reads the live value rather than a render-time snapshot
                     * — same pattern as `touchScrollState`.
                     */
                    const ctrlModifier = {
                        armed: false,
                    };

                    terminal.onData((data) => {
                        /**
                         * When Ctrl is armed, the next typed character is rewritten to its control
                         * byte and Ctrl disarms — exactly one keypress is modified, matching how a
                         * sticky modifier behaves. Multi-byte input (paste, IME composition) sends
                         * verbatim and still clears the modifier so it can't get stuck on.
                         */
                        if (ctrlModifier.armed) {
                            ctrlModifier.armed = false;
                            updateState({
                                ctrlArmed: false,
                            });
                            socket.send(data.length === 1 ? toControlByte(data) : data);
                            return;
                        }
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

                    /**
                     * One-shot initial fit replacing the previous unconditional pair. If the host
                     * is visible, this fits to the real layout and pushes those dims to the pty
                     * exactly as before. If it's hidden (mounting inside a not-yet-active
                     * pane-slot), the guard inside `fitAndResend` makes this a no-op and the
                     * ResizeObserver + `onActivate` path below picks it up the moment the slot
                     * gains a real layout.
                     */
                    fitAndResend();

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
                        sendBytes: (bytes) => socket.send(bytes),
                        toggleCtrl: () => {
                            ctrlModifier.armed = !ctrlModifier.armed;
                            updateState({
                                ctrlArmed: ctrlModifier.armed,
                            });
                        },
                        disconnect: () => {
                            void socket.close();
                        },
                    });
                })}
            ></div>
            ${inputs.showAccessoryKeys && state.sendBytes && state.toggleCtrl
                ? html`
                      <div class="accessory-bar" role="toolbar" aria-label="Terminal keys">
                          <button
                              type="button"
                              class="accessory-key"
                              title="Paste from clipboard"
                              ${listen('pointerdown', (event) => {
                                  event.preventDefault();
                                  if (state.terminal) {
                                      pasteIntoTerminal(state.terminal);
                                  }
                              })}
                          >
                              <${ViraIcon.assign({
                                  icon: clipboardIcon,
                              })}></${ViraIcon}>
                          </button>
                          <button
                              type="button"
                              class="accessory-key ctrl-key"
                              title="Ctrl — applies to the next key you press"
                              ?data-armed=${state.ctrlArmed}
                              ${listen('pointerdown', (event) => {
                                  // Keep the soft keyboard up: don't let the tap steal focus from
                                  // xterm's hidden textarea.
                                  event.preventDefault();
                                  state.toggleCtrl?.();
                              })}
                          >
                              ctrl
                          </button>
                          ${accessoryKeys.map(
                              (key) => html`
                                  <button
                                      type="button"
                                      class="accessory-key"
                                      title=${key.title}
                                      ${listen('pointerdown', (event) => {
                                          event.preventDefault();
                                          state.sendBytes?.(key.bytes);
                                      })}
                                  >
                                      ${key.label}
                                  </button>
                              `,
                          )}
                      </div>
                  `
                : ''}
        `;
    },
});
