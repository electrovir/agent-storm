import {ptyService} from '@agent-storm/common';
import {connectWebSocket} from '@rest-vir/define-service';
import {FitAddon} from '@xterm/addon-fit';
import {Terminal} from '@xterm/xterm';
import xtermCss from '@xterm/xterm/css/xterm.css?inline';
import {css, defineElement, html, onDomCreated, unsafeCSS} from 'element-vir';

export const VirTerminal = defineElement()({
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
            background: #000;
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
    render({state, updateState}) {
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
                    });
                    const fitAddon = new FitAddon();
                    terminal.loadAddon(fitAddon);
                    terminal.open(element);
                    fitAddon.fit();

                    const socket = await connectWebSocket(ptyService.webSockets['/pty'], {
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

                    terminal.attachCustomKeyEventHandler((event) => {
                        if (event.type !== 'keydown') {
                            return true;
                        } else if (event.metaKey && event.key === 'Backspace') {
                            socket.send('\x15');
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
