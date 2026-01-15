import type {Client} from 'ssh2';
import {execCommand} from '../ssh/ssh-connection.js';

export interface GitRepo {
    path: string;
    name: string;
    isWorktree: boolean;
    isBare: boolean;
}

export interface Worktree {
    path: string;
    branch: string;
    isBare: boolean;
}

export async function findGitRepos(
    client: Client,
    basePath: string = '~/repos',
): Promise<GitRepo[]> {
    const expandedPath = basePath.replace('~', '$HOME');

    // Find all .git directories or files (worktrees have .git files)
    const command = `find ${expandedPath} -maxdepth 3 -name ".git" 2>/dev/null | head -100`;

    try {
        const output = await execCommand(client, command);
        const gitPaths = output.trim().split('\n').filter(Boolean);

        const repos: GitRepo[] = [];

        for (const gitPath of gitPaths) {
            const repoPath = gitPath.replace(/\/.git$/, '');
            const repoName = repoPath.split('/').pop() || repoPath;

            // Check if it's a bare repo or worktree setup
            const isBareCheck = await execCommand(
                client,
                `cd "${repoPath}" && git rev-parse --is-bare-repository 2>/dev/null || echo "false"`,
            );
            const isBare = isBareCheck.trim() === 'true';

            // Check if repo uses worktrees
            let isWorktree = false;
            if (isBare) {
                // Bare repos are typically used for worktrees
                isWorktree = true;
            } else {
                try {
                    const worktreeList = await execCommand(
                        client,
                        `cd "${repoPath}" && git worktree list 2>/dev/null | wc -l`,
                    );
                    isWorktree = parseInt(worktreeList.trim(), 10) > 1;
                } catch {
                    isWorktree = false;
                }
            }

            repos.push({
                path: repoPath,
                name: repoName,
                isWorktree,
                isBare,
            });
        }

        return repos;
    } catch (error) {
        console.error('Error finding repos:', error);
        return [];
    }
}

export async function getWorktrees(client: Client, repoPath: string): Promise<Worktree[]> {
    try {
        const output = await execCommand(
            client,
            `cd "${repoPath}" && git worktree list --porcelain 2>/dev/null`,
        );
        const lines = output.trim().split('\n');

        const worktrees: Worktree[] = [];
        let currentWorktree: Partial<Worktree> = {};

        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                if (currentWorktree.path) {
                    worktrees.push(currentWorktree as Worktree);
                }
                currentWorktree = {path: line.slice(9), isBare: false};
            } else if (line.startsWith('branch ')) {
                currentWorktree.branch = line.slice(7).replace('refs/heads/', '');
            } else if (line === 'bare') {
                currentWorktree.isBare = true;
            }
        }

        if (currentWorktree.path) {
            worktrees.push(currentWorktree as Worktree);
        }

        // Filter out bare worktrees
        return worktrees.filter((wt) => !wt.isBare);
    } catch (error) {
        console.error('Error getting worktrees:', error);
        return [];
    }
}

export async function getCurrentBranch(client: Client, repoPath: string): Promise<string> {
    try {
        const output = await execCommand(
            client,
            `cd "${repoPath}" && git branch --show-current 2>/dev/null`,
        );
        return output.trim();
    } catch {
        return 'main';
    }
}

export async function createWorktree(
    client: Client,
    repoPath: string,
    worktreeName: string,
    branchName: string,
): Promise<string> {
    const worktreePath = `${repoPath}/${worktreeName}`;

    // Check if branch exists
    const branchExists = await execCommand(
        client,
        `cd "${repoPath}" && git show-ref --verify --quiet refs/heads/${branchName} && echo "yes" || echo "no"`,
    );

    if (branchExists.trim() === 'yes') {
        await execCommand(
            client,
            `cd "${repoPath}" && git worktree add "${worktreePath}" "${branchName}"`,
        );
    } else {
        await execCommand(
            client,
            `cd "${repoPath}" && git worktree add -b "${branchName}" "${worktreePath}"`,
        );
    }

    return worktreePath;
}

export async function copyGitIgnoredFiles(
    client: Client,
    sourceWorktree: string,
    targetWorktree: string,
): Promise<void> {
    // Get list of git-ignored files from source
    const command = `
        cd "${sourceWorktree}" && \
        git ls-files --others --ignored --exclude-standard 2>/dev/null | \
        while read file; do
            if [ -f "$file" ] && [ "$file" != ".git" ]; then
                mkdir -p "${targetWorktree}/$(dirname "$file")"
                cp "$file" "${targetWorktree}/$file" 2>/dev/null || true
            fi
        done
    `;

    try {
        await execCommand(client, command);
    } catch (error) {
        console.error('Error copying git-ignored files:', error);
    }
}

export async function findNearestNonEmptyWorktree(
    client: Client,
    repoPath: string,
    excludePath: string,
): Promise<string | null> {
    const worktrees = await getWorktrees(client, repoPath);

    for (const wt of worktrees) {
        if (wt.path === excludePath) {
            continue;
        }

        // Check if worktree has any files
        const fileCount = await execCommand(client, `ls -A "${wt.path}" 2>/dev/null | wc -l`);
        if (parseInt(fileCount.trim(), 10) > 0) {
            return wt.path;
        }
    }

    return null;
}

export async function checkoutBranch(
    client: Client,
    repoPath: string,
    branchName: string,
): Promise<void> {
    const branchExists = await execCommand(
        client,
        `cd "${repoPath}" && git show-ref --verify --quiet refs/heads/${branchName} && echo "yes" || echo "no"`,
    );

    if (branchExists.trim() === 'yes') {
        await execCommand(client, `cd "${repoPath}" && git checkout "${branchName}"`);
    } else {
        await execCommand(client, `cd "${repoPath}" && git checkout -b "${branchName}"`);
    }
}

export async function getBranches(client: Client, repoPath: string): Promise<string[]> {
    try {
        const output = await execCommand(
            client,
            `cd "${repoPath}" && git branch --format='%(refname:short)' 2>/dev/null`,
        );
        return output.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}
