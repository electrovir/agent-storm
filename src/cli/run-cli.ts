import {log} from '@augment-vir/common';
import terminalKit from 'terminal-kit';
import {
    cleanup,
    handleInput,
    initTui,
    setInputEnabled,
    setNewConnectionCallback,
} from '../tui/main-tui.js';
import {createAndConnectSshSession, showNewConnectionWizard} from '../tui/new-connection-wizard.js';

const term = terminalKit.terminal;

/** Waits for any key press. */
async function waitForAnyKey(): Promise<void> {
    term.grabInput(true);
    return new Promise((resolve) => {
        term.once('key', () => {
            term.grabInput(false);
            resolve();
        });
    });
}

async function handleNewConnection(): Promise<void> {
    setInputEnabled(false);
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
                await waitForAnyKey();
            }
        }
    } finally {
        term.grabInput({mouse: 'button'});
        setInputEnabled(true);
        initTui();
    }
}

/**
 * Runs the CLI application.
 *
 * @category Internal
 */
export function runCli(): void {
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
        handleNewConnection().catch(log.error);
    });

    process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        cleanup();
        process.exit(0);
    });

    initTui();
}
