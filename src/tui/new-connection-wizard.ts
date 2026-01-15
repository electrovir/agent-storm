import terminalKit from 'terminal-kit';
import {
    copyGitIgnoredFiles,
    createWorktree,
    findGitRepos,
    findNearestNonEmptyWorktree,
    getBranches,
    getCurrentBranch,
    getWorktrees,
    type Worktree,
} from '../git/git-operations.js';
import type {SshHost} from '../ssh/ssh-config-parser.js';
import {getHostsWithKeys} from '../ssh/ssh-config-parser.js';
import {
    connectSsh,
    createConnectionId,
    createShell,
    type SshConnection,
} from '../ssh/ssh-connection.js';
import {connectionManager} from '../utils/connection-manager.js';
import {updateConnectionOutput} from './main-tui.js';

const term = terminalKit.terminal;

export interface NewConnectionResult {
    host: SshHost;
    repoPath: string;
    worktreePath: string | undefined;
    branch: string | undefined;
    command: string;
}

async function showMenu<T>(
    title: string,
    items: {label: string; value: T; disabled?: boolean | undefined; reason?: string | undefined}[],
): Promise<T | null> {
    term.clear();
    term.bold.cyan(`\n  ${title}\n\n`);

    const enabledItems = items.filter((item) => !item.disabled);

    if (enabledItems.length === 0) {
        term.red('  No available options.\n');
        term.gray('  Press any key to go back...\n');
        await term.inputField({echo: false}).promise;
        return null;
    }

    // Display all items, showing disabled ones differently
    items.forEach((item, index) => {
        if (item.disabled) {
            term.gray(`  ${index + 1}. ${item.label} (${item.reason})\n`);
        } else {
            term.white(`  ${index + 1}. ${item.label}\n`);
        }
    });

    term('\n');

    const response = await term.singleColumnMenu(
        enabledItems.map((item) => item.label),
        {
            cancelable: true,
            exitOnUnexpectedKey: true,
        },
    ).promise;

    if (response.canceled) {
        return null;
    }

    const idx = response.selectedIndex as number | undefined;
    if (idx == undefined || idx < 0 || idx >= enabledItems.length) {
        return null;
    }

    const item = enabledItems[idx];
    return item ? item.value : null;
}

async function promptInput(prompt: string, defaultValue?: string): Promise<string | null> {
    term.clear();
    term.bold.cyan(`\n  ${prompt}\n\n`);

    if (defaultValue) {
        term.gray(`  Default: ${defaultValue}\n\n`);
    }

    term('  > ');
    const result = await term.inputField({
        cancelable: true,
        default: defaultValue,
    }).promise;

    if (result === undefined) {
        return null;
    }

    return result || defaultValue || null;
}

export async function showNewConnectionWizard(): Promise<NewConnectionResult | null> {
    // Step 1: Select host
    const hosts = getHostsWithKeys();

    if (hosts.length === 0) {
        term.clear();
        term.red('\n  No SSH hosts with configured keys found in ~/.ssh/config\n');
        term.gray('  Press any key to continue...\n');
        await term.inputField({echo: false}).promise;
        return null;
    }

    const selectedHost = await showMenu(
        'Select SSH Host',
        hosts.map((host) => ({
            label: `${host.name} (${host.user || 'default'}@${host.hostname})`,
            value: host,
        })),
    );

    if (!selectedHost) {
        return null;
    }

    // Connect temporarily to discover repos
    term.clear();
    term.yellow(`\n  Connecting to ${selectedHost.name}...\n`);

    let client;
    try {
        client = await connectSsh(selectedHost);
    } catch (error: unknown) {
        term.red(`\n  Failed to connect: ${String(error)}\n`);
        term.gray('  Press any key to continue...\n');
        await term.inputField({echo: false}).promise;
        return null;
    }

    // Step 2: List git repos
    term.yellow('  Discovering git repositories...\n');
    const repos = await findGitRepos(client);

    if (repos.length === 0) {
        term.red('\n  No git repositories found in ~/repos\n');
        term.gray('  Press any key to continue...\n');
        client.end();
        await term.inputField({echo: false}).promise;
        return null;
    }

    // Check which repos are in use
    const repoItems = repos.map((repo) => {
        const inUseBy = connectionManager.isRepoInUse(repo.path);
        const disabled = !repo.isWorktree && !!inUseBy;
        return {
            label: `${repo.name}${repo.isWorktree ? ' [worktree]' : ''}${repo.isBare ? ' [bare]' : ''}`,
            value: repo,
            disabled,
            reason: disabled ? `In use by connection ${inUseBy.id}` : undefined,
        };
    });

    const selectedRepo = await showMenu('Select Repository', repoItems);

    if (!selectedRepo) {
        client.end();
        return null;
    }

    let finalPath = selectedRepo.path;
    let selectedWorktree: Worktree | null = null;
    let newWorktreeCreated = false;
    let selectedBranch: string | undefined;

    // Step 3: If using worktrees, select or create one
    if (selectedRepo.isWorktree || selectedRepo.isBare) {
        const worktrees = await getWorktrees(client, selectedRepo.path);

        const worktreeItems: {
            label: string;
            value: Worktree | 'new';
            disabled?: boolean | undefined;
            reason?: string | undefined;
        }[] = [
            ...worktrees.map((wt) => ({
                label: `${wt.path.split('/').pop()} (${wt.branch})`,
                value: wt,
            })),
            {label: '+ Create new worktree', value: 'new'},
        ];

        const worktreeChoice = await showMenu('Select Worktree', worktreeItems);

        if (!worktreeChoice) {
            client.end();
            return null;
        }

        if (worktreeChoice === 'new') {
            const worktreeName = await promptInput('Enter worktree name:');
            if (!worktreeName) {
                client.end();
                return null;
            }

            const branchName = await promptInput('Enter branch name:', worktreeName);
            if (!branchName) {
                client.end();
                return null;
            }

            term.clear();
            term.yellow(`\n  Creating worktree ${worktreeName} with branch ${branchName}...\n`);

            try {
                finalPath = await createWorktree(
                    client,
                    selectedRepo.path,
                    worktreeName,
                    branchName,
                );
                selectedBranch = branchName;
                newWorktreeCreated = true;

                // Copy git-ignored files from nearest worktree
                const sourceWorktree = await findNearestNonEmptyWorktree(
                    client,
                    selectedRepo.path,
                    finalPath,
                );
                if (sourceWorktree) {
                    term.yellow(`  Copying git-ignored files from ${sourceWorktree}...\n`);
                    await copyGitIgnoredFiles(client, sourceWorktree, finalPath);
                }
            } catch (error: unknown) {
                term.red(`\n  Failed to create worktree: ${String(error)}\n`);
                term.gray('  Press any key to continue...\n');
                client.end();
                await term.inputField({echo: false}).promise;
                return null;
            }
        } else {
            selectedWorktree = worktreeChoice;
            finalPath = selectedWorktree.path;
            selectedBranch = selectedWorktree.branch;
        }
    }

    // Step 4: If not a new worktree, allow branch selection
    if (!newWorktreeCreated) {
        const currentBranch = await getCurrentBranch(client, finalPath);
        const branches = await getBranches(client, finalPath);

        const branchItems: {label: string; value: string}[] = [
            {label: `Current: ${currentBranch}`, value: currentBranch},
            ...branches.filter((b) => b !== currentBranch).map((b) => ({label: b, value: b})),
            {label: '+ Create new branch', value: '__new__'},
        ];

        const branchChoice = await showMenu('Select Branch', branchItems);

        if (!branchChoice) {
            client.end();
            return null;
        }

        if (branchChoice === '__new__') {
            const newBranchName = await promptInput('Enter new branch name:');
            if (!newBranchName) {
                client.end();
                return null;
            }
            selectedBranch = newBranchName;
        } else {
            selectedBranch = branchChoice;
        }
    }

    // Step 5: Optional command
    const command = await promptInput('Command to run after connecting (optional):', 'copilot');

    client.end();

    return {
        host: selectedHost,
        repoPath: selectedRepo.path,
        worktreePath: finalPath === selectedRepo.path ? undefined : finalPath,
        branch: selectedBranch,
        command: command || '',
    };
}

export async function createAndConnectSshSession(
    config: NewConnectionResult,
): Promise<SshConnection | null> {
    const client = await connectSsh(config.host);
    const shell = await createShell(client);

    const connection: SshConnection = {
        id: createConnectionId(),
        host: config.host,
        client,
        shell,
        currentDir: config.worktreePath || config.repoPath,
        repoPath: config.repoPath,
        worktreePath: config.worktreePath,
        branch: config.branch,
        isConnected: true,
        outputBuffer: '',
    };

    // Set up output handling
    shell.on('data', (data: Buffer) => {
        updateConnectionOutput(connection.id, data.toString());
    });

    shell.on('close', () => {
        connection.isConnected = false;
    });

    // Navigate to directory
    shell.write(`cd "${connection.currentDir}"\n`);

    // Checkout branch if specified and different from current
    if (config.branch) {
        const currentBranch = await getCurrentBranch(client, connection.currentDir);
        if (currentBranch !== config.branch) {
            shell.write(
                `git checkout ${config.branch} 2>/dev/null || git checkout -b ${config.branch}\n`,
            );
        }
    }

    // Run optional command
    if (config.command) {
        shell.write(`${config.command}\n`);
    }

    connectionManager.addConnection(connection);

    return connection;
}
