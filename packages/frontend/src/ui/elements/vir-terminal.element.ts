import {agentStormService, type PaneKind} from '@agent-storm/common';
import {connectWebSocket} from '@rest-vir/define-service';
import {FitAddon} from '@xterm/addon-fit';
import {Terminal, type ITheme} from '@xterm/xterm';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import {css, defineElement, html, onDomCreated, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {uploadFile} from '../../util/api-client.js';
import {ensureSecret} from '../../util/auth.js';

const uploadErrorDismissMs = 5_000;

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
        reader.addEventListener('error', () => reject(reader.error));
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
    return `'${input.replace(/'/g, "'\\''")}'`;
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
}>()({
    tagName: 'vir-terminal',
    state() {
        return {
            terminal: undefined as Terminal | undefined,
            resizeObserver: undefined as ResizeObserver | undefined,
            disconnect: undefined as (() => void) | undefined,
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
            padding: 8px;
            background: ${unsafeCSS(terminalAppTheme.background || 'transparent')};
        }

        .terminal-host {
            width: 100%;
            height: 100%;
        }

        ${unsafeCSS(xtermCss)}

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
                    await Promise.all([
                        document.fonts.load('13px "MesloLGS NF"'),
                        document.fonts.load('bold 13px "MesloLGS NF"'),
                        document.fonts.load('italic 13px "MesloLGS NF"'),
                    ]).catch(() => {
                        /* font load failure is non-fatal; xterm falls back to Menlo */
                    });

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
                    terminal.open(element);
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

                    const keyBindings: Record<string, string> = {
                        'meta+Backspace': '\x15',
                        'alt+Backspace': '\x17',
                        'meta+ArrowLeft': '\x01',
                        'meta+ArrowRight': '\x05',
                        'alt+ArrowLeft': '\x1b[1;3D',
                        'alt+ArrowRight': '\x1b[1;3C',
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
                                /* eslint-disable-next-line no-console */
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
                                    /* eslint-disable-next-line no-console */
                                    console.error('agent-storm paste upload failed:', error);
                                    reportDropError(updateState, state, `Paste failed: ${message}`);
                                });
                        },
                        true,
                    );

                    const resizeObserver = new ResizeObserver(() => {
                        fitAddon.fit();
                        sendResize();
                    });
                    resizeObserver.observe(element);

                    updateState({
                        terminal,
                        resizeObserver,
                        disconnect: () => {
                            socket.close();
                        },
                    });
                })}
            ></div>
        `;
    },
});
