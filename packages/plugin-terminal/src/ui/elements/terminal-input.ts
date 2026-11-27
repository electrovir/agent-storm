import {isNewTabShortcut, isSettingsShortcut} from '@agent-storm/core/frontend';
import {type Terminal} from '@xterm/xterm';
import {
    collectDroppedFiles,
    extractDroppedPaths,
    shellQuote,
    uploadDroppedFiles,
} from './terminal-drop.js';

type TerminalInputParams = Readonly<{
    /** The `.terminal-host` element xterm is opened in. */
    element: HTMLElement;
    terminal: Terminal;
    /** Writes raw bytes to the pty. */
    send: (data: string) => void;
    reportError: (message: string) => void;
}>;

/**
 * Alt+arrows send the Meta-letter sequences `\eb` (backward-word) and `\ef` (forward-word) because
 * readline (the line editor inside bash and zsh) does NOT bind xterm's "modified arrow" CSI form
 * `\x1b[1;3D` by default. When the shell receives it, it parses the CSI prefix, finds no binding,
 * and the trailing `D` / `C` falls through as a literal character (visible as the user types).
 */
function attachKeyBindings({terminal, send}: TerminalInputParams) {
    const keyBindings: Record<string, string> = {
        'meta+Backspace': '\x15',
        'alt+Backspace': '\x17',
        'meta+ArrowLeft': '\x01',
        'meta+ArrowRight': '\x05',
        'alt+ArrowLeft': '\x1bb',
        'alt+ArrowRight': '\x1bf',
    };

    terminal.attachCustomKeyEventHandler((event) => {
        if (event.type !== 'keydown') {
            return true;
        } else if (isSettingsShortcut(event)) {
            /** Left for `vir-app`, which opens Settings. Keeps xterm from also sending the key on. */
            return false;
        } else if (isNewTabShortcut(event)) {
            /**
             * Left for the keydown listener in `renderTerminal` (terminal-panes.ts) to handle as it
             * bubbles out. Without this xterm also sends Ctrl+T to the shell as \x14
             * (transpose-chars).
             */
            return false;
        }
        const modifier = event.metaKey ? 'meta' : event.altKey ? 'alt' : '';
        const bytes = keyBindings[`${modifier}+${event.key}`];
        if (bytes) {
            send(bytes);
            event.preventDefault();
            return false;
        }
        return true;
    });
}

/**
 * IPad touch-drag scrolling. xterm's WebGL canvas captures touch events and its own viewport-scroll
 * behavior doesn't kick in on touch, so the terminal scrollback is unreachable on iOS without this.
 * Translate a one-finger drag into `terminal.scrollLines` calls, sized against the actual rendered
 * row height when we can read it (falls back to the configured font size with xterm's 1.2
 * line-height multiplier).
 */
function attachTouchScroll({element, terminal}: TerminalInputParams) {
    const touchScrollState: {
        pointerId: number | undefined;
        startY: number;
        lastY: number;
        /** Whether the latest touch moved far enough to be a scroll rather than a tap. */
        didScroll: boolean;
    } = {
        pointerId: undefined,
        startY: 0,
        lastY: 0,
        didScroll: false,
    };
    element.addEventListener(
        'pointerdown',
        (event) => {
            touchScrollState.didScroll = false;
            if (event.pointerType !== 'touch') {
                return;
            }
            touchScrollState.pointerId = event.pointerId;
            touchScrollState.startY = event.clientY;
            touchScrollState.lastY = event.clientY;
        },
        {
            passive: true,
        },
    );
    element.addEventListener(
        'pointermove',
        (event) => {
            if (event.pointerType !== 'touch' || event.pointerId !== touchScrollState.pointerId) {
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
            if (Math.abs(event.clientY - touchScrollState.startY) > 10) {
                touchScrollState.didScroll = true;
            }
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
    function endTouchScroll(event: PointerEvent) {
        if (event.pointerId === touchScrollState.pointerId) {
            touchScrollState.pointerId = undefined;
        }
    }
    element.addEventListener('pointerup', endTouchScroll, {
        passive: true,
    });
    element.addEventListener('pointercancel', endTouchScroll, {
        passive: true,
    });
    /**
     * Mobile browsers still fire a mousedown after a short or slow drag, and xterm focuses its
     * hidden textarea on any mousedown, which opens the on-screen keyboard mid-scroll. Captured on
     * this ancestor so it runs before xterm's own listener.
     */
    element.addEventListener(
        'mousedown',
        (event) => {
            if (touchScrollState.didScroll) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        {
            capture: true,
        },
    );
}

async function uploadAndSendPaths({
    files,
    send,
    reportError,
    logMessage,
    errorPrefix,
}: Readonly<{
    files: ReadonlyArray<File>;
    send: (data: string) => void;
    reportError: (message: string) => void;
    logMessage: string;
    errorPrefix: string;
}>) {
    try {
        const uploadedPaths = await uploadDroppedFiles(files);
        send(uploadedPaths.map(shellQuote).join(' '));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        console.error(logMessage, error);
        reportError(`${errorPrefix}: ${message}`);
    }
}

function attachFileDrop({element, send, reportError}: TerminalInputParams) {
    element.addEventListener('dragover', (event) => {
        // dragover must be handled (preventDefault'd) for the matching drop event
        // to fire on a non-form element.
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    });
    element.addEventListener('drop', async (event) => {
        event.preventDefault();
        if (!event.dataTransfer) {
            return;
        }
        // `text/uri-list` gives us real on-disk paths from Finder; prefer it.
        const paths = extractDroppedPaths(event.dataTransfer);
        if (paths.length > 0) {
            send(paths.map(shellQuote).join(' '));
            return;
        }
        // No URI list: this is an in-memory blob (screenshot, dragged image from
        // a webpage, etc.). The browser sometimes exposes those via
        // `dataTransfer.files`, sometimes only via `dataTransfer.items` with
        // kind === 'file'. Collect from both and dedupe.
        const files = collectDroppedFiles(event.dataTransfer);
        if (files.length === 0) {
            reportError('Drop carried no file or path the browser would expose.');
            return;
        }
        await uploadAndSendPaths({
            files,
            send,
            reportError,
            logMessage: 'Agent Storm upload failed:',
            errorPrefix: 'Upload failed',
        });
    });

    // Intercept image pastes (Cmd+V after a screenshot) before xterm's textarea
    // sees them. Plain-text pastes fall through to xterm's default handler.
    // Capture phase so we run before the textarea's own paste handler can fire.
    element.addEventListener(
        'paste',
        async (event) => {
            if (!event.clipboardData) {
                return;
            }
            const imageFiles = Array.from(event.clipboardData.items)
                .filter((item) => {
                    return item.kind === 'file' && item.type.startsWith('image/');
                })
                .map((item) => item.getAsFile())
                .filter((file): file is File => !!file);
            if (imageFiles.length === 0) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            await uploadAndSendPaths({
                files: imageFiles,
                send,
                reportError,
                logMessage: 'Agent Storm paste upload failed:',
                errorPrefix: 'Paste failed',
            });
        },
        true,
    );
}

/**
 * Wires every input path that doesn't go through xterm's own `onData`: key bindings, touch
 * scrolling, and file drop / image paste uploads.
 */
export function attachTerminalInput(params: TerminalInputParams) {
    attachKeyBindings(params);
    attachTouchScroll(params);
    attachFileDrop(params);
}
