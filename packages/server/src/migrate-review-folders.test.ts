import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {normalizePath, runCommand} from 'agent-storm';
import {mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {migrateReviewFolders} from './migrate-review-folders.js';

type TestDirs = {
    dir: string;
    reviewsDir: string;
    legacyReviewsDir: string;
    legacyStatePath: string;
    statePath: string;
};

async function withUserDataDir(callback: (dirs: Readonly<TestDirs>) => Promise<void>) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'migrate-review-folders-')));
    try {
        await callback({
            dir,
            reviewsDir: join(dir, 'manual-review'),
            legacyReviewsDir: join(dir, 'reviews'),
            legacyStatePath: join(dir, 'checkout', 'pane-sessions.json'),
            statePath: join(dir, 'folder-state', 'pane-sessions.json'),
        });
    } finally {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

async function migrate({
    reviewsDir,
    legacyReviewsDir,
    legacyStatePath,
    statePath,
}: Readonly<TestDirs>) {
    await migrateReviewFolders({
        reviewsDir,
        legacyReviewsDir,
        folderKeyedFiles: [
            {
                legacyPath: legacyStatePath,
                path: statePath,
            },
        ],
    });
}

async function exists(path: string) {
    return !!(await stat(path).catch(() => undefined));
}

async function makeCheckouts(folders: ReadonlyArray<string>) {
    await Promise.all(
        folders.map(async (folder) => {
            await mkdir(join(folder, '.git'), {
                recursive: true,
            });
        }),
    );
}

async function writeJson(path: string, contents: Readonly<Record<string, unknown>>) {
    await mkdir(join(path, '..'), {
        recursive: true,
    });
    await writeFile(path, JSON.stringify(contents));
}

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, 'utf8'));
}

describe(migrateReviewFolders.name, () => {
    it('moves old review folders to their PR and points their state and folder keys at the new paths', async () => {
        await withUserDataDir(async (dirs) => {
            const nested = join(dirs.reviewsDir, 'web', 'feature', 'one');
            const unmapped = join(dirs.reviewsDir, 'web', 'mystery');
            const hereCopy = join(dirs.reviewsDir, 'web', 'review__feature-two');
            const legacyReview = join(dirs.legacyReviewsDir, 'acme', 'web', '10');
            await makeCheckouts([
                nested,
                unmapped,
                hereCopy,
                legacyReview,
            ]);
            await writeJson(join(dirs.reviewsDir, 'state.json'), {
                'acme/web': {
                    'feature/one': {
                        prNumber: 7,
                        folder: nested,
                    },
                    'feature/two': {
                        prNumber: 8,
                        folder: hereCopy,
                    },
                    ten: {
                        prNumber: 10,
                        folder: legacyReview,
                    },
                },
                'fork/web': {
                    'feature/one': {
                        prNumber: 9,
                    },
                },
            });
            await writeJson(dirs.legacyStatePath, {
                [hereCopy]: 'here',
                [unmapped]: 'unmapped',
            });

            await migrate(dirs);

            assert.deepEquals(
                await Promise.all(
                    [
                        join(dirs.reviewsDir, 'acme', 'web', '7', '.git'),
                        join(dirs.reviewsDir, 'acme', 'web', '8', '.git'),
                        join(dirs.reviewsDir, 'acme', 'web', '10', '.git'),
                        join(dirs.reviewsDir, 'web', 'feature'),
                        unmapped,
                        dirs.legacyReviewsDir,
                        dirs.legacyStatePath,
                    ].map(exists),
                ),
                [
                    true,
                    true,
                    true,
                    false,
                    true,
                    false,
                    false,
                ],
            );
            assert.deepEquals(await readJson(join(dirs.reviewsDir, 'state.json')), {
                'acme/web': {
                    'feature/one': {
                        prNumber: 7,
                        folder: join(dirs.reviewsDir, 'acme', 'web', '7'),
                    },
                    'feature/two': {
                        prNumber: 8,
                        folder: join(dirs.reviewsDir, 'acme', 'web', '8'),
                    },
                    ten: {
                        prNumber: 10,
                        folder: join(dirs.reviewsDir, 'acme', 'web', '10'),
                    },
                },
                'fork/web': {
                    'feature/one': {
                        prNumber: 9,
                    },
                },
            });
            assert.deepEquals(await readJson(dirs.statePath), {
                [join(dirs.reviewsDir, 'acme', 'web', '8')]: 'here',
                [unmapped]: 'unmapped',
            });
        });
    });

    it('leaves a folder in place when it matches more than one PR or its destination holds something', async () => {
        await withUserDataDir(async (dirs) => {
            const shared = join(dirs.reviewsDir, 'web', 'shared');
            const blocked = join(dirs.legacyReviewsDir, 'acme', 'web', '3');
            const replacesEmpty = join(dirs.legacyReviewsDir, 'acme', 'web', '4');
            await makeCheckouts([
                shared,
                blocked,
                replacesEmpty,
                join(dirs.reviewsDir, 'acme', 'web', '3'),
            ]);
            await mkdir(join(dirs.reviewsDir, 'acme', 'web', '4'), {
                recursive: true,
            });
            await writeJson(join(dirs.reviewsDir, 'state.json'), {
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

            await migrate(dirs);

            assert.deepEquals(
                await Promise.all(
                    [
                        shared,
                        join(dirs.reviewsDir, 'acme', 'web', '1'),
                        blocked,
                        replacesEmpty,
                        join(dirs.reviewsDir, 'acme', 'web', '4', '.git'),
                    ].map(exists),
                ),
                [
                    true,
                    false,
                    true,
                    false,
                    true,
                ],
            );
        });
    });

    it('moves a worktree through git so its repo still lists it', async () => {
        await withUserDataDir(async (dirs) => {
            const repo = join(dirs.dir, 'web');
            const worktree = join(dirs.reviewsDir, 'web', 'feature');
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
            await mkdir(join(dirs.reviewsDir, 'web'), {
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
            await writeJson(join(dirs.reviewsDir, 'state.json'), {
                'acme/web': {
                    feature: {
                        prNumber: 3,
                    },
                },
            });

            await migrate(dirs);

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
            /** Git prints `/` separators even on Windows. */
            assert.isTrue(
                stdout.split('\n').some((line) => {
                    return (
                        line.startsWith('worktree ') &&
                        normalizePath(line.slice('worktree '.length)) ===
                            join(dirs.reviewsDir, 'acme', 'web', '3')
                    );
                }),
            );
            assert.deepEquals((await readdir(dirs.reviewsDir)).toSorted(), [
                'acme',
                'state.json',
            ]);
        });
    });
});
