#!/usr/bin/env node

import terminalKit from 'terminal-kit';
import {
    cleanup,
    handleInput,
    initTui,
    renderTui,
    setNewConnectionCallback,
} from './tui/main-tui.js';
import {createAndConnectSshSession, showNewConnectionWizard} from './tui/new-connection-wizard.js';

const term = terminalKit.terminal;

async function handleNewConnection(): Promise<void> {
    term.grabInput(false);

    try {
        const config = await showNewConnectionWizard();

        if (config) {
            term.clear();
            term.yellow(`\n  Establishing SSH connection to ${config.host.name}...\n`);

            try {
                await createAndConnectSshSession(config);
                term.green('  Connection established!\n');
            } catch (error: unknown) {
                term.red(`\n  Failed to establish connection: ${String(error)}\n`);
                term.gray('  Press any key to continue...\n');
                await term.inputField({echo: false}).promise;
            }
        }
    } finally {
        term.grabInput({mouse: 'button'});
        initTui();
    }
}

function main(): void {
    term.on(
        'key',
        (
            key: string,
            matches: string[],
            data: {isCharacter: boolean; codepoint: number; code: Buffer},
        ) => {
            if (key === 'CTRL_C') {
                cleanup();
                process.exit(0);
            }
            handleInput(key, matches, data.code);
        },
    );

    setNewConnectionCallback(() => {
        handleNewConnection().catch(console.error);
    });

    initTui();

    term.bold.cyan('\n  SSH Connection Manager\n');
    term.gray('  Press "n" to create a new connection or navigate with arrow keys.\n\n');

    renderTui();
}

process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
});

process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
});

try {
    main();
} catch (error: unknown) {
    cleanup();
    console.error('Fatal error:', error);
    process.exit(1);
}
