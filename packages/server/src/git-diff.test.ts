// cspell:word unstages

import {GitDiffSide} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {discardAllChanges, discardHunkChanges, getDiffStatus, setSideStaged} from './git-diff.js';

const exec = promisify(execFile);

const committedLines = [
    'one',
    'two',
    'three',
    'four',
    'five',
];

/** A repo whose only file is {@link committedLines}, committed, plus that file's absolute path. */
async function createRepo() {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-diff-'));
    const filePath = join(folder, 'file.txt');
    await exec('git', [
        'init',
        '--initial-branch=main',
        folder,
    ]);
    await exec('git', [
        '-C',
        folder,
        'config',
        'user.email',
        'test@example.com',
    ]);
    await exec('git', [
        '-C',
        folder,
        'config',
        'user.name',
        'test',
    ]);
    await writeFile(filePath, `${committedLines.join('\n')}\n`);
    await exec('git', [
        '-C',
        folder,
        'add',
        '.',
    ]);
    await exec('git', [
        '-C',
        folder,
        'commit',
        '-m',
        'initial',
    ]);
    return {
        folder,
        filePath,
    };
}

/** Both edited lines, so a discard that took the wrong range out is visible in the result. */
async function writeTwoEdits(filePath: string): Promise<void> {
    await writeFile(
        filePath,
        [
            'one',
            'TWO',
            'three',
            'FOUR',
            'five',
            '',
        ].join('\n'),
    );
}

/**
 * An untracked file alongside an edit to the committed one. Untracked is the case worth covering:
 * it has no `HEAD` state, so staging and discarding it both take a different branch than a plain
 * modification does.
 */
async function writeEditAndUntracked({
    folder,
    filePath,
}: Readonly<{folder: string; filePath: string}>): Promise<void> {
    await writeTwoEdits(filePath);
    await writeFile(join(folder, 'new.txt'), 'brand new\n');
}

describe(setSideStaged.name, () => {
    it('stages every unstaged file, including untracked ones', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeEditAndUntracked({
                folder,
                filePath,
            });
            await setSideStaged({
                folder,
                side: GitDiffSide.Unstaged,
            });
            const status = await getDiffStatus(folder);
            assert.deepEquals(
                {
                    staged: status.staged.map((file) => file.path).toSorted(),
                    unstaged: status.unstaged.map((file) => file.path),
                },
                {
                    staged: [
                        'file.txt',
                        'new.txt',
                    ],
                    unstaged: [],
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('unstages every staged file', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeEditAndUntracked({
                folder,
                filePath,
            });
            await setSideStaged({
                folder,
                side: GitDiffSide.Unstaged,
            });
            await setSideStaged({
                folder,
                side: GitDiffSide.Staged,
            });
            const status = await getDiffStatus(folder);
            assert.deepEquals(
                {
                    staged: status.staged.map((file) => file.path),
                    unstaged: status.unstaged.map((file) => file.path).toSorted(),
                },
                {
                    staged: [],
                    unstaged: [
                        'file.txt',
                        'new.txt',
                    ],
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });
});

describe(discardAllChanges.name, () => {
    it('restores tracked files and deletes untracked ones, staged or not', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeEditAndUntracked({
                folder,
                filePath,
            });
            /** Staged on one side, unstaged on the other, so both branches get exercised at once. */
            await exec('git', [
                '-C',
                folder,
                'add',
                'file.txt',
            ]);
            await discardAllChanges(folder);
            const status = await getDiffStatus(folder);
            assert.deepEquals(
                {
                    committedFile: await readFile(filePath, 'utf8'),
                    untrackedFileExists: await readFile(join(folder, 'new.txt'), 'utf8').then(
                        () => true,
                        () => false,
                    ),
                    staged: status.staged.map((file) => file.path),
                    unstaged: status.unstaged.map((file) => file.path),
                },
                {
                    committedFile: `${committedLines.join('\n')}\n`,
                    untrackedFileExists: false,
                    staged: [],
                    unstaged: [],
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });
});

describe(discardHunkChanges.name, () => {
    it('reverts one unstaged hunk and leaves the other alone', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeTwoEdits(filePath);
            await discardHunkChanges({
                folder,
                path: 'file.txt',
                oldPath: undefined,
                side: GitDiffSide.Unstaged,
                fromOldLine: 1,
                toOldLine: 2,
                fromNewLine: 1,
                toNewLine: 2,
            });
            assert.strictEquals(
                await readFile(filePath, 'utf8'),
                [
                    'one',
                    'two',
                    'three',
                    'FOUR',
                    'five',
                    '',
                ].join('\n'),
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('takes a staged hunk out of the index and the working tree together', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeTwoEdits(filePath);
            await exec('git', [
                '-C',
                folder,
                'add',
                'file.txt',
            ]);
            await discardHunkChanges({
                folder,
                path: 'file.txt',
                oldPath: undefined,
                side: GitDiffSide.Staged,
                fromOldLine: 1,
                toOldLine: 2,
                fromNewLine: 1,
                toNewLine: 2,
            });
            const {stdout} = await exec('git', [
                '-C',
                folder,
                'show',
                ':file.txt',
            ]);
            const expected = [
                'one',
                'two',
                'three',
                'FOUR',
                'five',
                '',
            ].join('\n');
            assert.deepEquals(
                {
                    index: stdout,
                    worktree: await readFile(filePath, 'utf8'),
                },
                {
                    index: expected,
                    worktree: expected,
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });
});
