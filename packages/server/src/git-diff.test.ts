// cspell:words unstages, endobj

import {GitDiffSide} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {execFile} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {
    discardHunkChanges,
    discardUnstagedChanges,
    getDiffFileContents,
    getDiffStatus,
    setSideStaged,
} from './git-diff.js';

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
    /** The tests read the file's bytes, which Windows CI's default `true` would turn into CRLF. */
    await exec('git', [
        '-C',
        folder,
        'config',
        'core.autocrlf',
        'false',
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

describe(discardUnstagedChanges.name, () => {
    it('restores the working tree from the index and deletes untracked files', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await writeEditAndUntracked({
                folder,
                filePath,
            });
            /** Staged, so the discard has something it must leave behind. */
            await exec('git', [
                '-C',
                folder,
                'add',
                'file.txt',
            ]);
            /** One more edit on top of what's staged: this is the only part that should go. */
            await writeFile(
                filePath,
                [
                    'ONE',
                    'TWO',
                    'three',
                    'FOUR',
                    'five',
                    '',
                ].join('\n'),
            );
            await discardUnstagedChanges(folder);
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
                    committedFile: [
                        'one',
                        'TWO',
                        'three',
                        'FOUR',
                        'five',
                        '',
                    ].join('\n'),
                    untrackedFileExists: false,
                    staged: ['file.txt'],
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

/** Two real 1x1 PNGs, transparent and red, so the two sides differ in bytes as well as in pixels. */
const transparentPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const redPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe(getDiffFileContents.name, () => {
    it('returns both sides of a modified image as data URLs', async () => {
        const {folder} = await createRepo();
        try {
            const imagePath = join(folder, 'icon.png');
            await writeFile(imagePath, Buffer.from(transparentPngBase64, 'base64'));
            await exec('git', [
                '-C',
                folder,
                'add',
                'icon.png',
            ]);
            await exec('git', [
                '-C',
                folder,
                'commit',
                '-m',
                'add icon',
            ]);
            await writeFile(imagePath, Buffer.from(redPngBase64, 'base64'));

            assert.deepEquals(
                await getDiffFileContents({
                    folder,
                    path: 'icon.png',
                    oldPath: undefined,
                    side: GitDiffSide.Unstaged,
                    allowLarge: false,
                }),
                {
                    oldContent: '',
                    newContent: '',
                    isImage: true,
                    oldImage: `data:image/png;base64,${transparentPngBase64}`,
                    newImage: `data:image/png;base64,${redPngBase64}`,
                    tooLargeOrBinary: false,
                    canShowAnyway: false,
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('withholds a pdf whose bytes contain no NUL', async () => {
        const {folder} = await createRepo();
        try {
            await writeFile(
                join(folder, 'report.pdf'),
                [
                    '%PDF-1.7',
                    '1 0 obj',
                    '<< /Type /Catalog >>',
                    'endobj',
                    '',
                ].join('\n'),
            );

            assert.deepEquals(
                await getDiffFileContents({
                    folder,
                    path: 'report.pdf',
                    oldPath: undefined,
                    side: GitDiffSide.Unstaged,
                    allowLarge: false,
                }),
                {
                    oldContent: '',
                    newContent: '',
                    isImage: false,
                    tooLargeOrBinary: true,
                    canShowAnyway: false,
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('leaves the missing side of an untracked image undefined', async () => {
        const {folder} = await createRepo();
        try {
            await writeFile(join(folder, 'added.png'), Buffer.from(transparentPngBase64, 'base64'));

            assert.deepEquals(
                await getDiffFileContents({
                    folder,
                    path: 'added.png',
                    oldPath: undefined,
                    side: GitDiffSide.Unstaged,
                    allowLarge: false,
                }),
                {
                    oldContent: '',
                    newContent: '',
                    isImage: true,
                    oldImage: undefined,
                    newImage: `data:image/png;base64,${transparentPngBase64}`,
                    tooLargeOrBinary: false,
                    canShowAnyway: false,
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
