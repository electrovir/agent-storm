import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    hasActiveChangesRequested,
    isReviewCheck,
    latestChecksByName,
    listWorktreeChildren,
    removeWorktree,
} from './git.js';

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
    async function initRepo(parent: string, mainPath: string): Promise<void> {
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
        const worktreePath = join(parent, 'efax-portal-work-item');
        try {
            await initRepo(parent, mainPath);
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'add',
                    '../efax-portal-work-item',
                ],
            });
            await git({
                cwd: mainPath,
                args: [
                    'worktree',
                    'lock',
                    '../efax-portal-work-item',
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
            await initRepo(parent, mainPath);
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

describe(hasActiveChangesRequested.name, () => {
    it('flags a reviewer who currently requests changes', () => {
        const result = hasActiveChangesRequested(
            [{state: 'CHANGES_REQUESTED', author: {login: 'alice'}}],
            new Set(),
        );
        assert.isTrue(result);
    });

    it('does not flag a reviewer who requested changes but was since re-requested', () => {
        const result = hasActiveChangesRequested(
            [{state: 'CHANGES_REQUESTED', author: {login: 'alice'}}],
            new Set(['alice']),
        );
        assert.isFalse(result);
    });

    it('does not flag an approving reviewer', () => {
        const result = hasActiveChangesRequested(
            [{state: 'APPROVED', author: {login: 'alice'}}],
            new Set(),
        );
        assert.isFalse(result);
    });

    it('still flags when one reviewer blocks and another was re-requested', () => {
        const result = hasActiveChangesRequested(
            [
                {state: 'CHANGES_REQUESTED', author: {login: 'alice'}},
                {state: 'CHANGES_REQUESTED', author: {login: 'bob'}},
            ],
            new Set(['bob']),
        );
        assert.isTrue(result);
    });

    it('is false when there are no reviews', () => {
        assert.isFalse(hasActiveChangesRequested([], new Set()));
    });
});

describe(latestChecksByName.name, () => {
    it('keeps only the most recent run of a repeated check name', () => {
        const collapsed = latestChecksByName([
            {
                name: 'Check Review Status',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                startedAt: '2026-09-17T19:34:20Z',
                completedAt: '2026-09-17T19:34:53Z',
            },
            {
                name: 'Check Review Status',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: '2026-09-21T17:38:10Z',
                completedAt: '2026-09-21T17:38:26Z',
            },
            {
                name: 'lint',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                startedAt: '2026-09-21T17:30:00Z',
                completedAt: '2026-09-21T17:32:00Z',
            },
        ]);

        assert.deepEquals(
            collapsed.map((check) => [
                check.name,
                check.conclusion,
            ]),
            [
                [
                    'Check Review Status',
                    'SUCCESS',
                ],
                [
                    'lint',
                    'SUCCESS',
                ],
            ],
        );
    });

    it('prefers an in-progress re-run over the completed run it supersedes', () => {
        const collapsed = latestChecksByName([
            {
                name: 'compile',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                startedAt: '2026-09-21T10:00:00Z',
                completedAt: '2026-09-21T10:05:00Z',
            },
            {
                name: 'compile',
                status: 'IN_PROGRESS',
                startedAt: '2026-09-21T11:00:00Z',
            },
        ]);

        assert.strictEquals(collapsed.length, 1);
        assert.strictEquals(collapsed[0]?.status, 'IN_PROGRESS');
    });

    it('collapses legacy StatusContext entries by their context name', () => {
        const collapsed = latestChecksByName([
            {
                context: 'ci/legacy',
                state: 'FAILURE',
                createdAt: '2026-09-20T10:00:00Z',
            },
            {
                context: 'ci/legacy',
                state: 'SUCCESS',
                createdAt: '2026-09-21T10:00:00Z',
            },
        ]);

        assert.strictEquals(collapsed.length, 1);
        assert.strictEquals(collapsed[0]?.state, 'SUCCESS');
    });
});

describe(isReviewCheck.name, () => {
    it('matches code-review checks', () => {
        assert.isTrue(isReviewCheck({name: 'PR Review'}));
        assert.isTrue(isReviewCheck({name: 'Check Review Status'}));
        assert.isTrue(isReviewCheck({name: 'reviewdog'}));
    });

    it('does not match build checks that merely contain the letters', () => {
        assert.isFalse(isReviewCheck({context: 'netlify/example-org/deploy-preview'}));
        assert.isFalse(isReviewCheck({name: 'compile'}));
    });
});
