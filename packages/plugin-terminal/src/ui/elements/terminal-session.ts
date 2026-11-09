// cspell:words meslo menlo keymap toggleable

import {ptyWebSocket, settingsEndpoint, type PaneKind} from '@agent-storm/common';
import {
    client,
    ensureSecret,
    fetchApi,
    isDarkMode,
    listenToDarkMode,
    localStorageClient,
} from '@agent-storm/core/frontend';
import {HttpMethod} from '@rest-vir/api';
import {FitAddon} from '@xterm/addon-fit';
import {WebLinksAddon} from '@xterm/addon-web-links';
import {WebglAddon} from '@xterm/addon-webgl';
import {Terminal} from '@xterm/xterm';
import {createTerminalFitter, stableFitFrames} from './terminal-fit.js';
import {attachTerminalInput} from './terminal-input.js';
import {terminalColors, terminalTheme} from './terminal-theme.js';

/** `VirTerminal`'s inputs, read live because setup reads some of them only after its awaits. */
type TerminalSessionInputs = Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
    focusOnMount: boolean;
}>;

/**
 * Convert a typed character to the control byte a physical Ctrl+<key> would emit: the terminal
 * convention is `byte & 0x1f`, so Ctrl+C → `\x03`, Ctrl+D → `\x04`, Ctrl+L → `\x0c`, etc. Used by
 * the mobile accessory bar's sticky Ctrl, where there's no hardware Ctrl key to hold.
 */
export function toControlByte(input: string): string {
    return String.fromCodePoint((input.toUpperCase().codePointAt(0) ?? 0) & 0x1f);
}

async function createTerminal({
    element,
    inputs,
}: Readonly<{
    element: HTMLElement;
    inputs: TerminalSessionInputs;
}>) {
    // Wait for the bundled MesloLGS NF to load before xterm measures cell
    // widths against the fallback (Menlo) and ends up with wrong column metrics.
    // Fetch settings in parallel so the WebGL toggle is ready by the time we need it.
    const [
        ,
        ,
        ,
        settings,
    ] = await Promise.all([
        document.fonts.load('13px "MesloLGS NF"').catch(() => undefined),
        document.fonts.load('bold 13px "MesloLGS NF"').catch(() => undefined),
        document.fonts.load('italic 13px "MesloLGS NF"').catch(() => undefined),
        // If the settings fetch fails (e.g. server briefly unreachable), default
        // to WebGL on — matches the optionalShape default and pre-toggle behavior.
        fetchApi(settingsEndpoint, HttpMethod.Get).catch(() => undefined),
    ]);
    // optionalShape default is true; treat undefined as on.
    const useWebgl = settings?.useWebgl !== false;
    const clickableLinks = settings?.terminalClickableLinks !== false;

    /**
     * User-controlled cap on how many scrollback lines this pane retains. Read once here (not
     * persisted to the backend config) and reused as the connect search param so the daemon replays
     * at most this many lines on attach.
     */
    const scrollbackLimit = localStorageClient.scrollbackLimit.read();

    const terminal = new Terminal({
        fontFamily: '"MesloLGS NF", Menlo, monospace',
        fontSize: 13,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 3,
        scrollback: scrollbackLimit,
        theme: terminalTheme(isDarkMode()),
        /**
         * Seed xterm with the daemon's spawn-default dims (see `pty-pool.ts`'s `spawn({cols: 120,
         * rows: 32})`). Until `fitAndResend` runs successfully — which it can't do while this pane
         * is mounted `display: none` for a not-yet-active folder — xterm renders any scrollback the
         * daemon replays at these dims. Matching the pty default means lines wrap consistently; the
         * alternative (xterm's own 80×24 default) would mis-wrap the replay against a pty that's
         * running at 120 cols.
         */
        cols: 120,
        rows: 32,
        /**
         * Characters that break a word for double-click selection. xterm's default (' ()[]{}',:;`)
         * only includes whitespace + a handful of punctuation, so something like
         * `src/foo.element.test.ts` selects as one big "word". Add structural delimiters like path
         * separators, comparison ops, backticks, and hashes, while keeping dotted filenames
         * together.
         */
        wordSeparator: ' \t\n()[]{}\'",:;/\\<>`=-#*',
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    /**
     * `WebLinksAddon` is what makes URLs in terminal output ctrl-clickable / tappable and opens
     * them in a new tab. Gated behind `terminalClickableLinks` so users on touch devices (where
     * accidental taps fire links) or those who never want auto- opening can disable it via the
     * settings modal.
     */
    if (clickableLinks) {
        terminal.loadAddon(new WebLinksAddon());
    }
    terminal.open(element);
    if (inputs.focusOnMount) {
        terminal.focus();
    }

    /**
     * WebGL must be attached after `open()` because it needs the DOM-mounted canvases to bind to.
     * On a context loss (tab send to the background long enough for the browser to reclaim the GPU
     * context, driver crash, etc.) we dispose the addon and let xterm fall through to its DOM
     * renderer rather than leave the terminal blank. WebGL construction itself can throw on
     * machines without WebGL2 — wrap it so those users also fall through to DOM rather than getting
     * a blank pane.
     *
     * Toggleable via the settings modal; the preference is read once at terminal construction, so
     * the modal reloads the page after a change to apply it.
     */
    if (useWebgl) {
        try {
            const webglAddon = new WebglAddon();
            webglAddon.onContextLoss(() => {
                webglAddon.dispose();
            });
            terminal.loadAddon(webglAddon);
        } catch (error) {
            console.warn('xterm WebGL renderer unavailable, falling back to DOM', error);
        }
    }

    /**
     * Intentionally skip an eager `fitAddon.fit()` here. If this terminal is mounting inside a
     * `display: none` pane-slot (a folder the user added to `openedFolders` but hasn't activated),
     * the host's content rect is 0×0 and `fit()` would shrink xterm to its minimum (cols ≈ 1–2).
     * The subsequent `sendResize` would then push those tiny dims to the daemon, the pty would
     * resize to match, and any pty output produced before the pane became visible would be wrapped
     * — and any TUI redrawn — at a degenerate width that ends up permanently in the scrollback.
     * `fitAndResend()` carries the `< 10px` guard that suppresses exactly this case.
     */

    /**
     * Silently swallow color/palette queries (OSC 10 / 11 / 12 / 4 with `?` arg). Some tools —
     * starship, neovim, claude's status renderer, etc. — ask the terminal for its current fg / bg /
     * cursor color so they can color-match. The terminal's response is supposed to be consumed by
     * the asker, but if the asker exits before reading stdin (or never bothers), the response leaks
     * into the shell at the next prompt as visible gibberish like `11;rgb:ffff/ffff/fff6`.
     * agent-storm's theme is fully controlled here, so the shell never actually needs these
     * responses. Return `true` from the OSC handler to mark the query as consumed; xterm skips its
     * default response. `set` forms (no `?`) still fall through to the default handler so apps that
     * legitimately want to change palette colors can.
     */
    function swallowColorQuery(data: string): boolean {
        return data.startsWith('?');
    }
    [
        10,
        11,
        12,
        4,
    ].forEach((code) => {
        terminal.parser.registerOscHandler(code, swallowColorQuery);
    });

    /**
     * Same leak shape as the OSC color queries above, but for Device Status Report (`CSI Ps n`).
     * zsh's interactive startup, prompt plugins (starship, p10k), and various TUIs query the cursor
     * position with `CSI 6 n` and expect xterm to reply via `terminal.onData` with `CSI <row>;<col>
     * R`. That reply is forwarded to the pty as if the user typed it, and any chunk of it the asker
     * doesn't drain before the next process starts reading stdin shows up as visible gibberish like
     * `9;1R` (the CSI prefix gets eaten by the shell's keymap and the row/col/R suffix prints
     * verbatim). The pane has well-defined dimensions already, so no app actually needs this answer
     * to be routed through the pty. Returning `true` consumes the query and suppresses xterm's
     * default reply.
     */
    terminal.parser.registerCsiHandler(
        {
            final: 'n',
        },
        () => true,
    );

    return {
        terminal,
        fitAddon,
        scrollbackLimit,
    };
}

/**
 * Creates the xterm instance in `element`, connects it to the pty socket, and wires input, fitting,
 * and theme following. Resolves to `undefined` (with everything it built already torn down) when
 * `isUnmounted` turns true during setup's awaits.
 */
export async function connectTerminalSession({
    element,
    inputs,
    isUnmounted,
    onCtrlArmedChange,
    onDarkThemeChange,
    reportError,
}: Readonly<{
    element: HTMLElement;
    inputs: TerminalSessionInputs;
    /**
     * Read through a call so TypeScript can't narrow it across the awaits. It genuinely flips when
     * the element's `cleanup` runs partway through setup, which is exactly what the checks are here
     * to catch.
     */
    isUnmounted: () => boolean;
    onCtrlArmedChange: (isArmed: boolean) => void;
    onDarkThemeChange: (isDark: boolean) => void;
    reportError: (message: string) => void;
}>) {
    const {terminal, fitAddon, scrollbackLimit} = await createTerminal({
        element,
        inputs,
    });

    const secret = await ensureSecret();
    /**
     * Bail before opening the socket if this element was torn down while the awaits above were in
     * flight (a fast session-tab or folder switch). Opening it now would attach a PTY subscriber
     * that nothing can ever detach.
     */
    if (isUnmounted()) {
        terminal.dispose();
        return undefined;
    }
    /**
     * Holds pty output until the terminal knows how wide it is.
     *
     * A freshly constructed xterm is 120×32 until the first fit, and the pty's replayed scrollback
     * is the very first thing the socket delivers — often before xterm has even measured its cell
     * box, which is what a fit needs. Text written in that window gets wrapped at 120 columns and
     * stays that way; the fit that follows resizes the terminal but does not un-wrap what is
     * already in the buffer. Queueing until the size is settled is the only way the replay is ever
     * laid out at the width it will be read at.
     */
    const writeGate = {
        ready: false,
        pending: [] as string[],
    };
    function writeToTerminal(data: string) {
        if (writeGate.ready) {
            terminal.write(data);
        } else {
            writeGate.pending = [
                ...writeGate.pending,
                data,
            ];
        }
    }
    function openWriteGate() {
        if (writeGate.ready) {
            return;
        }
        writeGate.ready = true;
        const queued = writeGate.pending;
        writeGate.pending = [];
        queued.forEach((data) => terminal.write(data));
    }

    const socket = await client.connectWebSocket(ptyWebSocket, {
        searchParams: {
            folder: inputs.folder,
            kind: inputs.kind,
            sessionId: inputs.sessionId,
            scrollbackLimit: String(scrollbackLimit),
            ...terminalColors(isDarkMode()),
        },
        protocols: [secret],
        listeners: {
            message({message}) {
                writeToTerminal(message);
            },
            close() {
                writeToTerminal('\r\n[connection closed]\r\n');
            },
        },
    });

    /**
     * The handshake itself is another await, so re-check: if the element went away while it
     * completed, close the socket here since `cleanup` has already run and will not run again.
     */
    if (isUnmounted()) {
        terminal.dispose();
        await socket.close();
        return undefined;
    }

    function sendResize() {
        socket.send({
            resize: {
                cols: terminal.cols,
                rows: terminal.rows,
            },
        });
    }

    /**
     * Sticky Ctrl state for the mobile accessory bar. Kept as a closure object (mirrored out
     * through `onCtrlArmedChange` for the button's active style) so the `onData` handler below
     * always reads the live value rather than a render-time snapshot.
     */
    const ctrlModifier = {
        armed: false,
    };

    terminal.onData((data) => {
        /**
         * When Ctrl is armed, the next typed character is rewritten to its control byte and Ctrl
         * disarms — exactly one keypress is modified, matching how a sticky modifier behaves.
         * Multi-byte input (paste, IME composition) sends verbatim and still clears the modifier so
         * it can't get stuck on.
         */
        if (ctrlModifier.armed) {
            ctrlModifier.armed = false;
            onCtrlArmedChange(false);
            socket.send(data.length === 1 ? toControlByte(data) : data);
            return;
        }
        socket.send(data);
    });

    attachTerminalInput({
        element,
        terminal,
        kind: inputs.kind,
        send(data) {
            socket.send(data);
        },
        reportError,
    });

    const fitter = createTerminalFitter({
        element,
        terminal,
        fitAddon,
        sendResize,
        openWriteGate,
    });

    /*
     * The one fit that must not wait. A freshly `open()`ed terminal in a visible pane has just
     * measured its cell box, so there is no stale measurement to settle out — and the pty's
     * replayed scrollback is already on its way. Every frame spent waiting is a frame in which that
     * replay is written into a terminal still at xterm's construction-time 120×32 and wrapped there
     * for good.
     */
    fitter.fitAndResend(0);

    const resizeObserver = new ResizeObserver(() => {
        fitter.fitAndResend(stableFitFrames);
    });
    resizeObserver.observe(element);

    /**
     * A palette swap only reaches the cells that get drawn afterwards — everything already on
     * screen keeps the colors it was rendered with, and the WebGL renderer's glyph atlas still
     * holds them too. `repaintGlyphs` throws that atlas away and redraws the visible rows in the
     * new palette.
     */
    const stopThemeListener = listenToDarkMode((isDark) => {
        terminal.options.theme = terminalTheme(isDark);
        onDarkThemeChange(isDark);
        fitter.repaintGlyphs();
        /** The pty keeps asking for colors, so the daemon needs the new pair. */
        socket.send({
            colors: terminalColors(isDark),
        });
    });

    return {
        terminal,
        resizeObserver,
        /**
         * Revealing a pane fires the ResizeObserver too, so this is usually redundant — but a pane
         * revealed at exactly the size it already had produces no observer entry, and that is the
         * case that used to come back wrapped at a stale width.
         */
        onActivate() {
            fitter.fitAndResend(stableFitFrames);
        },
        stopThemeListener,
        sendBytes(bytes: string) {
            socket.send(bytes);
        },
        toggleCtrl() {
            ctrlModifier.armed = !ctrlModifier.armed;
            onCtrlArmedChange(ctrlModifier.armed);
        },
        /** Runs from the element's synchronous `cleanup`, so the close can't be awaited. */
        disconnect() {
            void socket.close();
        },
    };
}
