import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    addReviewComment,
    deleteReviewComment,
    readReviewComments,
    updateReviewComment,
} from './review-comments.js';

const exec = promisify(execFile);

async function withReviewRepo(
    callback: (params: {folder: string; statePath: string}) => Promise<void>,
) {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'review-comments-')));
    const folder = join(dir, 'repo');
    try {
        await exec('git', [
            'init',
            '--quiet',
            '--initial-branch=review__feature/one',
            folder,
        ]);
        await exec('git', [
            '-C',
            folder,
            'remote',
            'add',
            'origin',
            'https://github.com/acme/web.git',
        ]);
        await exec('git', [
            '-C',
            folder,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--quiet',
            '--allow-empty',
            '--message',
            'head',
        ]);
        await callback({
            folder,
            statePath: join(dir, 'state.json'),
        });
    } finally {
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

describe(addReviewComment.name, () => {
    it('stores comments under the head branch of the review the folder holds, keeping its status', async () => {
        await withReviewRepo(async ({folder, statePath}) => {
            await writeFile(
                statePath,
                JSON.stringify({
                    'acme/web': {
                        'feature/one': {
                            status: 'started',
                            isPending: false,
                            lastUpdatedAt: 1,
                        },
                    },
                }),
            );
            await addReviewComment({
                folder,
                statePath,
                path: 'src/a.ts',
                line: 3,
                body: 'rename **this**',
            });
            const [
                removed,
                kept,
            ] = await addReviewComment({
                folder,
                statePath,
                path: 'src/a.ts',
                line: 9,
                body: 'and this',
            }).then((comments) => {
                assert.isLengthExactly(comments, 2);
                return comments;
            });
            await deleteReviewComment({
                folder,
                statePath,
                id: removed.id,
            });

            assert.deepEquals(JSON.parse(await readFile(statePath, 'utf8')), {
                'acme/web': {
                    'feature/one': {
                        status: 'started',
                        isPending: false,
                        lastUpdatedAt: 1,
                        comments: [
                            kept,
                        ],
                    },
                },
            });
            assert.deepEquals(
                await readReviewComments({
                    folder,
                    statePath,
                }),
                [
                    kept,
                ],
            );
        });
    });

    it('prefers the entry recorded for this checkout over the origin repo', async () => {
        await withReviewRepo(async ({folder, statePath}) => {
            await writeFile(
                statePath,
                JSON.stringify({
                    'fork-owner/web': {
                        'feature/one': {
                            folder,
                        },
                    },
                }),
            );
            await addReviewComment({
                folder,
                statePath,
                path: 'src/a.ts',
                line: 1,
                body: 'note',
            });
            assert.deepEquals(Object.keys(JSON.parse(await readFile(statePath, 'utf8'))), [
                'fork-owner/web',
            ]);
        });
    });
    it('leaves an unreadable state file alone', async () => {
        await withReviewRepo(async ({folder, statePath}) => {
            await writeFile(statePath, '{not json');
            await assert.throws(
                addReviewComment({
                    folder,
                    statePath,
                    path: 'src/a.ts',
                    line: 1,
                    body: 'note',
                }),
            );
            assert.strictEquals(await readFile(statePath, 'utf8'), '{not json');
        });
    });

    it('gives up on a lock another process is still holding', async () => {
        await withReviewRepo(async ({folder, statePath}) => {
            await mkdir(`${statePath}.lock`);
            await assert.throws(
                addReviewComment({
                    folder,
                    statePath,
                    path: 'src/a.ts',
                    line: 1,
                    body: 'note',
                }),
                {
                    matchMessage: 'Timed out',
                },
            );
            assert.isTrue((await stat(`${statePath}.lock`)).isDirectory());
        });
    });
});

describe(updateReviewComment.name, () => {
    it('replaces the body of only the matching comment', async () => {
        await withReviewRepo(async ({folder, statePath}) => {
            await addReviewComment({
                folder,
                statePath,
                path: 'src/a.ts',
                line: 1,
                body: 'first',
            });
            const comments = await addReviewComment({
                folder,
                statePath,
                path: 'src/a.ts',
                line: 2,
                body: 'second',
            });
            assert.isLengthExactly(comments, 2);

            assert.deepEquals(
                await updateReviewComment({
                    folder,
                    statePath,
                    id: comments[0].id,
                    body: 'first, edited',
                }),
                [
                    {
                        ...comments[0],
                        body: 'first, edited',
                    },
                    comments[1],
                ],
            );
        });
    });
});
