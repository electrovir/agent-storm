import {agentStormService, type PaneKind} from '@agent-storm/common';
import {connectWebSocket} from '@rest-vir/define-service';
import {FitAddon} from '@xterm/addon-fit';
import {Terminal, type ITheme} from '@xterm/xterm';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import {css, defineElement, html, onDomCreated, unsafeCSS} from 'element-vir';

/**
 * Extracted from Terminal.app's `vir-light` profile via the bundled `extract-terminal-theme.swift`
 * helper. Slots that the plist omits (because they match Terminal.app's built-in defaults) are
 * filled in here so xterm renders the full 16-color palette.
 */
const terminalAppTheme: ITheme = {
    background: '#ffffff',
    foreground: '#0220b3',
    cursor: '#ff2600',
    cursorAccent: '#ffffff',
    selectionBackground: 'rgba(56, 213, 255, 0.5)',
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
        };
    },
    styles: css`
        :host {
            display: block;
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
    `,
    cleanup({state}) {
        state.resizeObserver?.disconnect();
        state.disconnect?.();
        state.terminal?.dispose();
    },
    render({inputs, state, updateState}) {
        return html`
            <div
                class="terminal-host"
                ${onDomCreated(async (element) => {
                    if (state.terminal || !(element instanceof HTMLElement)) {
                        return;
                    }

                    const terminal = new Terminal({
                        fontFamily: 'Menlo, monospace',
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

                    const socket = await connectWebSocket(agentStormService.webSockets['/pty'], {
                        searchParams: {
                            folder: [inputs.folder],
                            kind: [inputs.kind],
                        },
                        listeners: {
                            message({message}) {
                                terminal.write(message);
                            },
                            close() {
                                terminal.write('\r\n[connection closed]\r\n');
                            },
                        },
                    });

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

                    const resizeObserver = new ResizeObserver(() => {
                        fitAddon.fit();
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
