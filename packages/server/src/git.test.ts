// cspell:words gitdir

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {listWorktreeChildren, removeWorktree} from './git.js';

const exec = promisify(execFile);

async function git({
    cwd,
    args,
}: Readonly<{
    cwd: string;
    args: ReadonlyArray<string>;
}>): Promise<void> {
    await exec('git', [...args], {
        cwd,
    });
}

describe(removeWorktree.name, () => {
    async function initRepo({
        parent,
        mainPath,
    }: Readonly<{
        parent: string;
        mainPath: string;
    }>): Promise<void> {
        await git({
            cwd: parent,
            args: [
                'init',
                'main',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'config',
                'user.email',
                'test@example.com',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'config',
                'user.name',
                'Test User',
            ],
        });
        await writeFile(join(mainPath, 'tracked.txt'), 'base\n');
        await git({
            cwd: mainPath,
            args: [
                'add',
                'tracked.txt',
            ],
        });
        await git({
            cwd: mainPath,
            args: [
                'commit',
                '-m',
                'Initial commit',
            ],
        });
    }

    it('removes dirty locked worktrees', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'agent-storm-git-'));
        const mainPath = join(parent, 'main');
        const worktreePath = join(parent, 'feature-work-item');
        try {
            await initRepo({
                parent,
                mainPath,
            });
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'add',
                    '../feature-work-item',
                ],
            });
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'lock',
                    '../feature-work-item',
                ],
            });
            await writeFile(join(worktreePath, 'tracked.txt'), 'changed\n');
            await writeFile(join(worktreePath, 'untracked.txt'), 'untracked\n');

            await removeWorktree({
                worktreePath,
            });

            const removedWorktree = await stat(worktreePath).catch(() => undefined);
            const remainingChildren = await listWorktreeChildren(parent);

            assert.deepEquals(
                {
                    removedWorktree: !!removedWorktree,
                    remainingChildren,
                },
                {
                    removedWorktree: false,
                    remainingChildren: [
                        mainPath,
                    ],
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });

    it('removes filesystem worktree-looking folders when git removal rejects them', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'agent-storm-git-'));
        const mainPath = join(parent, 'main');
        const worktreePath = join(parent, 'orphaned-worktree');
        try {
            await initRepo({
                parent,
                mainPath,
            });
            await mkdir(worktreePath);
            await writeFile(join(worktreePath, '.git'), 'gitdir: /missing/gitdir\n');
            await writeFile(join(worktreePath, 'untracked.txt'), 'untracked\n');

            await removeWorktree({
                worktreePath,
            });

            const removedWorktree = await stat(worktreePath).catch(() => undefined);
            const remainingChildren = await listWorktreeChildren(parent);

            assert.deepEquals(
                {
                    removedWorktree: !!removedWorktree,
                    remainingChildren,
                },
                {
                    removedWorktree: false,
                    remainingChildren: [
                        mainPath,
                    ],
                },
            );
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});
