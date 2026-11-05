import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateReviewFolders} from './migrate-review-folders.js';
import {runCommand} from './run-command.js';

async function withUserDataDir(
    callback: (params: {dir: string; skillDir: string; reviewsDir: string}) => Promise<void>,
) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'migrate-review-folders-')));
    try {
        await callback({
            dir,
            skillDir: join(dir, 'manual-review'),
            reviewsDir: join(dir, 'reviews'),
        });
    } finally {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

async function exists(path: string) {
    return !!(await stat(path).catch(() => undefined));
}

async function writeState(skillDir: string, state: Readonly<Record<string, unknown>>) {
    await mkdir(skillDir, {
        recursive: true,
    });
    await writeFile(join(skillDir, 'state.json'), JSON.stringify(state));
}

describe(migrateReviewFolders.name, () => {
    it('moves each folder to its PR, preferring the entry recorded for that folder, and leaves the rest', async () => {
        await withUserDataDir(async ({skillDir, reviewsDir}) => {
            const nested = join(skillDir, 'web', 'feature', 'one');
            const unmapped = join(skillDir, 'web', 'mystery');
            const hereCopy = join(skillDir, 'web', 'review__feature-two');
            await Promise.all(
                [
                    nested,
                    unmapped,
                    hereCopy,
                ].map(async (folder) => {
                    await mkdir(join(folder, '.git'), {
                        recursive: true,
                    });
                }),
            );
            await writeState(skillDir, {
                'acme/web': {
                    'feature/one': {
                        prNumber: 7,
                        folder: nested,
                    },
                    'feature-two': {
                        prNumber: 8,
                    },
                },
                'fork/web': {
                    'feature/one': {
                        prNumber: 9,
                    },
                },
            });

            await migrateReviewFolders({
                skillDir,
                reviewsDir,
            });

            assert.deepEquals(
                await Promise.all(
                    [
                        join(reviewsDir, 'acme', 'web', '7', '.git'),
                        join(skillDir, 'web', 'feature'),
                        unmapped,
                        hereCopy,
                        join(reviewsDir, 'fork'),
                    ].map(exists),
                ),
                [
                    true,
                    false,
                    true,
                    true,
                    false,
                ],
            );
        });
    });

    it('leaves a folder that matches more than one PR in place', async () => {
        await withUserDataDir(async ({skillDir, reviewsDir}) => {
            const folder = join(skillDir, 'web', 'shared');
            await mkdir(join(folder, '.git'), {
                recursive: true,
            });
            await writeState(skillDir, {
                'acme/web': {
                    shared: {
                        prNumber: 1,
                    },
                },
                'fork/web': {
                    shared: {
                        prNumber: 2,
                    },
                },
            });

            await migrateReviewFolders({
                skillDir,
                reviewsDir,
            });

            assert.deepEquals(
                await Promise.all(
                    [
                        folder,
                        reviewsDir,
                    ].map(exists),
                ),
                [
                    true,
                    false,
                ],
            );
        });
    });

    it('moves a worktree through git so its repo still lists it', async () => {
        await withUserDataDir(async ({dir, skillDir, reviewsDir}) => {
            const repo = join(dir, 'web');
            const worktree = join(skillDir, 'web', 'feature');
            await runCommand(
                'git',
                [
                    'init',
                    '--quiet',
                    repo,
                ],
                {
                    timeout: {
                        seconds: 30,
                    },
                },
            );
            await runCommand(
                'git',
                [
                    '-C',
                    repo,
                    '-c',
                    'user.name=Test',
                    '-c',
                    'user.email=test@example.com',
                    'commit',
                    '--quiet',
                    '--allow-empty',
                    '--message',
                    'head',
                ],
                {
                    timeout: {
                        seconds: 30,
                    },
                },
            );
            await mkdir(join(skillDir, 'web'), {
                recursive: true,
            });
            await runCommand(
                'git',
                [
                    '-C',
                    repo,
                    'worktree',
                    'add',
                    '--quiet',
                    '-b',
                    'feature',
                    worktree,
                ],
                {
                    timeout: {
                        seconds: 30,
                    },
                },
            );
            await writeState(skillDir, {
                'acme/web': {
                    feature: {
                        prNumber: 3,
                    },
                },
            });

            await migrateReviewFolders({
                skillDir,
                reviewsDir,
            });

            const {stdout} = await runCommand(
                'git',
                [
                    '-C',
                    repo,
                    'worktree',
                    'list',
                    '--porcelain',
                ],
                {
                    timeout: {
                        seconds: 30,
                    },
                },
            );
            assert.isTrue(stdout.includes(`worktree ${join(reviewsDir, 'acme', 'web', '3')}\n`));
            assert.deepEquals((await readdir(dir)).toSorted(), [
                'manual-review',
                'reviews',
                'web',
            ]);
        });
    });
});
