import terminalKit from 'terminal-kit';
import {connectionManager} from '../utils/connection-manager.js';
import {openInVsCode} from '../utils/vscode-integration.js';

const term = terminalKit.terminal;

/**
 * Represents the TUI state.
 *
 * @category Internal
 */
export interface TuiState {
    sidebarWidth: number;
    sidebarFocused: boolean;
    selectedIndex: number;
    showingMenu: boolean;
    menuIndex: number;
}

let tuiState: TuiState = {
    sidebarWidth: 30,
    sidebarFocused: true,
    selectedIndex: 0,
    showingMenu: false,
    menuIndex: 0,
};

let onNewConnectionCallback: (() => void) | null = null;
let inputEnabled = true;

/**
 * Sets whether TUI input handling is enabled.
 *
 * @category Internal
 */
export function setInputEnabled(enabled: boolean): void {
    inputEnabled = enabled;
}

/**
 * Sets the callback for new connection creation.
 *
 * @category Internal
 */
export function setNewConnectionCallback(callback: () => void): void {
    onNewConnectionCallback = callback;
}

/**
 * Initializes the TUI.
 *
 * @category Internal
 */
export function initTui(): void {
    term.clear();
    term.hideCursor();
    term.grabInput({mouse: 'button'});
    renderTui();
}

/**
 * Renders the TUI.
 *
 * @category Internal
 */
export function renderTui(): void {
    term.clear();
    renderSidebar();
    renderTerminalPanel();
    renderStatusBar();
}

function renderSidebar(): void {
    const connections = connectionManager.getAllConnections();
    const selectedId = connectionManager.getSelectedConnectionId();

    // Draw header
    term.moveTo(1, 1);
    term.bgBlue().white().bold('═══ SSH Connections ═══'.padEnd(tuiState.sidebarWidth));

    // Draw connections
    let y = 3;
    connections.forEach((conn, index) => {
        const isSelected = conn.id === selectedId;
        const isFocused = tuiState.sidebarFocused && index === tuiState.selectedIndex;

        const prefix = isSelected ? '▶ ' : '  ';
        const displayName = `${conn.host.name}:${conn.repoPath.split('/').pop()}`;
        const truncated = displayName.slice(0, Math.max(0, tuiState.sidebarWidth - 4));

        term.moveTo(1, y);
        if (isFocused) {
            term.bgCyan();
        } else {
            term.bgBlue();
        }
        if (isSelected) {
            term.yellow().bold();
        } else {
            term.white();
        }
        term(`${prefix}${truncated}`.padEnd(tuiState.sidebarWidth));
        term.styleReset();

        if (tuiState.showingMenu && index === tuiState.selectedIndex) {
            const menuItems = [
                'View',
                'Open in VS Code',
                'Close',
            ];
            menuItems.forEach((item, menuIdx) => {
                term.moveTo(3, y + 1 + menuIdx);
                if (menuIdx === tuiState.menuIndex) {
                    term.bgWhite().black();
                } else {
                    term.bgGray().white();
                }
                term(` ${item} `.padEnd(tuiState.sidebarWidth - 4));
                term.styleReset();
            });
        }

        y++;
    });

    // Draw "New Connection" option
    const newConnY = y + 1;
    const isNewConnFocused =
        tuiState.sidebarFocused && tuiState.selectedIndex === connections.length;
    term.moveTo(1, newConnY);
    if (isNewConnFocused) {
        term.bgCyan();
    } else {
        term.bgBlue();
    }
    term.green().bold('+ New Connection'.padEnd(tuiState.sidebarWidth));
    term.styleReset();

    // Draw vertical separator
    for (let lineY = 1; lineY < term.height - 1; lineY++) {
        term.moveTo(tuiState.sidebarWidth + 1, lineY);
        term.gray('│');
    }
}

function renderTerminalPanel(): void {
    const connection = connectionManager.getSelectedConnection();
    const startX = tuiState.sidebarWidth + 2;
    const width = term.width - startX;
    const height = term.height - 2;

    if (connection && connection.outputBuffer) {
        const lines = connection.outputBuffer.split('\n');
        const visibleLines = lines.slice(-height);

        visibleLines.forEach((line, index) => {
            const truncatedLine = line.slice(0, Math.max(0, width));
            term.moveTo(startX, index + 1);
            term.white(truncatedLine);
        });
    } else if (!connection) {
        term.moveTo(startX + 2, Math.floor(height / 2));
        term.gray('No connection selected. Press "n" to create one.');
    }
}

function renderStatusBar(): void {
    const statusY = term.height;
    const connection = connectionManager.getSelectedConnection();

    let statusText = ' [↑↓] Navigate | [Enter] Select | [n] New | [v] VS Code | [q] Quit';
    if (connection) {
        statusText = ` ${connection.host.name} | ${connection.currentDir} |` + statusText;
    }

    term.moveTo(1, statusY);
    term.bgWhite().black(statusText.padEnd(term.width));
    term.styleReset();
}

/**
 * Handles keyboard input.
 *
 * @category Internal
 */
export function handleInput(key: string, matches: string[], data: Buffer): void {
    if (!inputEnabled) {
        return;
    }

    const connections = connectionManager.getAllConnections();
    const totalItems = connections.length + 1;

    if (tuiState.sidebarFocused) {
        if (tuiState.showingMenu) {
            handleMenuInput(key);
        } else {
            handleSidebarInput(key, totalItems);
        }
    } else {
        const connection = connectionManager.getSelectedConnection();
        if (connection?.shell) {
            connection.shell.write(data);
        }
    }

    renderTui();
}

function handleSidebarInput(key: string, totalItems: number): void {
    const connections = connectionManager.getAllConnections();

    switch (key) {
        case 'UP':
            tuiState.selectedIndex = Math.max(0, tuiState.selectedIndex - 1);
            break;
        case 'DOWN':
            tuiState.selectedIndex = Math.min(totalItems - 1, tuiState.selectedIndex + 1);
            break;
        case 'ENTER':
            if (tuiState.selectedIndex === connections.length) {
                if (onNewConnectionCallback) {
                    onNewConnectionCallback();
                }
            } else if (tuiState.selectedIndex < connections.length) {
                const conn = connections[tuiState.selectedIndex];
                if (conn) {
                    connectionManager.selectConnection(conn.id);
                    tuiState.sidebarFocused = false;
                }
            }
            break;
        case 'TAB':
        case 'RIGHT':
            if (connections.length > 0) {
                tuiState.sidebarFocused = false;
            }
            break;
        case 'm':
        case 'SPACE':
            if (tuiState.selectedIndex < connections.length) {
                tuiState.showingMenu = true;
                tuiState.menuIndex = 0;
            }
            break;
        case 'n':
            if (onNewConnectionCallback) {
                onNewConnectionCallback();
            }
            break;
        case 'v':
            if (tuiState.selectedIndex < connections.length) {
                const conn = connections[tuiState.selectedIndex];
                if (conn) {
                    openInVsCode(conn.host.name, conn.currentDir);
                }
            }
            break;
        case 'q':
        case 'CTRL_C':
            cleanup();
            process.exit(0);
            break;
    }
}

function handleMenuInput(key: string): void {
    const connections = connectionManager.getAllConnections();
    const conn = connections[tuiState.selectedIndex];

    switch (key) {
        case 'UP':
            tuiState.menuIndex = Math.max(0, tuiState.menuIndex - 1);
            break;
        case 'DOWN':
            tuiState.menuIndex = Math.min(2, tuiState.menuIndex + 1);
            break;
        case 'ENTER':
            if (conn) {
                switch (tuiState.menuIndex) {
                    case 0:
                        connectionManager.selectConnection(conn.id);
                        tuiState.sidebarFocused = false;
                        break;
                    case 1:
                        openInVsCode(conn.host.name, conn.currentDir);
                        break;
                    case 2:
                        connectionManager.removeConnection(conn.id);
                        tuiState.selectedIndex = Math.max(0, tuiState.selectedIndex - 1);
                        break;
                }
            }
            tuiState.showingMenu = false;
            break;
        case 'ESCAPE':
        case 'LEFT':
            tuiState.showingMenu = false;
            break;
    }
}

/**
 * Handles terminal input.
 *
 * @category Internal
 */
export function handleTerminalInput(key: string, data: Buffer): void {
    if (key === 'ESCAPE' || key === 'CTRL_B') {
        tuiState.sidebarFocused = true;
        renderTui();
        return;
    }

    const connection = connectionManager.getSelectedConnection();
    if (connection?.shell) {
        connection.shell.write(data);
    }
}

/**
 * Updates a connection's output buffer.
 *
 * @category Internal
 */
export function updateConnectionOutput(connectionId: string, data: string): void {
    const connection = connectionManager.getConnection(connectionId);
    if (connection) {
        connection.outputBuffer += data;
        if (connection.outputBuffer.length > 100_000) {
            connection.outputBuffer = connection.outputBuffer.slice(-50_000);
        }
        if (connectionManager.getSelectedConnectionId() === connectionId) {
            renderTui();
        }
    }
}

/**
 * Cleans up the TUI.
 *
 * @category Internal
 */
export function cleanup(): void {
    term.clear();
    term.hideCursor(false);
    term.grabInput(false);
}

/**
 * Gets the current TUI state.
 *
 * @category Internal
 */
export function getTuiState(): TuiState {
    return tuiState;
}

/**
 * Sets the TUI state.
 *
 * @category Internal
 */
export function setTuiState(newState: Partial<TuiState>): void {
    tuiState = {...tuiState, ...newState};
}
