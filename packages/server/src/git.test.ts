// cspell:words gitdir

import {assert} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {calculateRelativeDate, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {buildPrsByBranch, listWorktreeChildren, removeWorktree} from './git.js';

const exec = promisify(execFile);

function daysAgoIso(days: number): string {
    return toUtcIsoString(
        calculateRelativeDate(getNowInUtcTimezone(), {
            days: -days,
        }),
    );
}

describe(buildPrsByBranch.name, () => {
    it('keeps an open PR over a terminal one on the same branch', () => {
        const prs = buildPrsByBranch({
            openNodes: [
                {
                    url: 'https://github.com/owner/name/pull/2',
                    headRefName: 'feature',
                    state: 'OPEN',
                },
            ],
            terminalNodes: [
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'feature',
                    state: 'CLOSED',
                    closedAt: daysAgoIso(1),
                },
            ],
        });
        assert.deepEquals(prs.get('feature'), {
            url: 'https://github.com/owner/name/pull/2',
            closed: false,
        });
    });

    it('drops a terminal PR past the seven day window', () => {
        const prs = buildPrsByBranch({
            openNodes: [],
            terminalNodes: [
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'old',
                    state: 'MERGED',
                    closedAt: daysAgoIso(8),
                },
                {
                    url: 'https://github.com/owner/name/pull/3',
                    headRefName: 'fresh',
                    state: 'MERGED',
                    closedAt: daysAgoIso(2),
                },
            ],
        });
        assert.deepEquals(Array.from(prs.keys()), ['fresh']);
        assert.isTrue(prs.get('fresh')?.closed);
    });

    it('finds an open PR that merge churn would have pushed out of a single ordered list', () => {
        /**
         * The failure this guards: twenty PRs merged this week, and the one open PR on the
         * worktree's branch hasn't been updated since. A combined `first: 20` ordered by
         * `UPDATED_AT` returns only the merged ones and the branch loses its sidebar marker.
         */
        const prs = buildPrsByBranch({
            openNodes: [
                {
                    url: 'https://github.com/owner/name/pull/1',
                    headRefName: 'stale-but-open',
                    state: 'OPEN',
                },
            ],
            terminalNodes: createArray(20, (index) => {
                return {
                    url: `https://github.com/owner/name/pull/${index + 100}`,
                    headRefName: `merged-${index}`,
                    state: 'MERGED',
                    closedAt: daysAgoIso(1),
                };
            }),
        });
        assert.isDefined(prs.get('stale-but-open'));
    });
});

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
