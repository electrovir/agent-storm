// cspell:words unstages, endobj

import {GitDiffSide, GitFileChange, maxDiffFileBytes} from '@agent-storm/common';
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
    getPullRequestStatus,
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

async function createEmptyRepo() {
    const folder = await mkdtemp(join(tmpdir(), 'agent-storm-diff-'));
    await exec('git', [
        'init',
        '--initial-branch=main',
        folder,
    ]);
    return folder;
}

/** A repo whose only file is {@link committedLines}, committed, plus that file's absolute path. */
async function createRepo() {
    const folder = await createEmptyRepo();
    const filePath = join(folder, 'file.txt');
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

describe(getDiffStatus.name, () => {
    it('counts staged lines before the first commit', async () => {
        const folder = await createEmptyRepo();
        try {
            const path = 'file.txt';
            await writeFile(join(folder, path), 'first\nsecond\n');
            await exec('git', [
                '-C',
                folder,
                'add',
                '--',
                path,
            ]);

            const status = await getDiffStatus(folder);
            assert.deepEquals(status.staged, [
                {
                    path,
                    change: GitFileChange.Added,
                    oldPath: undefined,
                    insertions: 2,
                    deletions: 0,
                },
            ]);
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });
});

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
    it('reports an error when a staged file exceeds the Git read limit', async () => {
        const folder = await createEmptyRepo();
        const path = 'oversized.txt';
        try {
            await writeFile(join(folder, path), Buffer.alloc(maxDiffFileBytes * 5, 'x'));
            await exec('git', [
                '-C',
                folder,
                'add',
                path,
            ]);

            await assert.throws(
                getDiffFileContents({
                    folder,
                    path,
                    side: GitDiffSide.Staged,
                    allowLarge: true,
                }),
                {
                    matchMessage: "Git output exceeded the Diff pane's size limit.",
                },
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

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

describe(getPullRequestStatus.name, () => {
    it('lists what the branch committed since leaving its base, with a readable diff', async () => {
        const {folder, filePath} = await createRepo();
        try {
            await exec('git', [
                '-C',
                folder,
                'switch',
                '--create',
                'feature',
            ]);
            await writeFile(filePath, `${committedLines.join('\n')}\nsix\n`);
            await exec('git', [
                '-C',
                folder,
                'commit',
                '--all',
                '-m',
                'add a line',
            ]);
            /** Uncommitted work belongs to the source diff, not the PR's. */
            await writeFile(join(folder, 'draft.txt'), 'draft\n');

            const status = await getPullRequestStatus({
                folder,
                baseBranch: 'main',
            });
            assert.deepEquals(status.pullRequest, [
                {
                    path: 'file.txt',
                    oldPath: undefined,
                    change: GitFileChange.Modified,
                    insertions: 1,
                    deletions: 0,
                },
            ]);
            const contents = await getDiffFileContents({
                folder,
                path: 'file.txt',
                oldPath: undefined,
                side: GitDiffSide.PullRequest,
                baseCommit: status.pullRequestBase,
                allowLarge: false,
            });
            assert.deepEquals(
                [
                    contents.oldContent,
                    contents.newContent,
                ],
                [
                    `${committedLines.join('\n')}\n`,
                    `${committedLines.join('\n')}\nsix\n`,
                ],
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('counts only the edited lines when a PR renames a file', async () => {
        const {folder} = await createRepo();
        const renamedPath = 'renamed.txt';
        try {
            await exec('git', [
                '-C',
                folder,
                'switch',
                '--create',
                'feature',
            ]);
            await exec('git', [
                '-C',
                folder,
                'mv',
                'file.txt',
                renamedPath,
            ]);
            await writeFile(
                join(folder, renamedPath),
                [
                    ...committedLines.slice(0, -1),
                    'FIVE',
                    '',
                ].join('\n'),
            );
            await exec('git', [
                '-C',
                folder,
                'commit',
                '--all',
                '-m',
                'Rename and edit the file',
            ]);

            const status = await getPullRequestStatus({
                folder,
                baseBranch: 'main',
            });
            assert.deepEquals(status.pullRequest, [
                {
                    path: renamedPath,
                    oldPath: 'file.txt',
                    change: GitFileChange.Renamed,
                    insertions: 1,
                    deletions: 1,
                },
            ]);
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reads again once the branch moves', async () => {
        const {folder} = await createRepo();
        try {
            await exec('git', [
                '-C',
                folder,
                'switch',
                '--create',
                'feature',
            ]);
            const before = await getPullRequestStatus({
                folder,
                baseBranch: 'main',
            });
            await writeFile(join(folder, 'added.txt'), 'added\n');
            await exec('git', [
                '-C',
                folder,
                'add',
                'added.txt',
            ]);
            await exec('git', [
                '-C',
                folder,
                'commit',
                '-m',
                'add a file',
            ]);
            const after = await getPullRequestStatus({
                folder,
                baseBranch: 'main',
            });
            assert.deepEquals(
                [
                    before.pullRequest,
                    after.pullRequest,
                ],
                [
                    [],
                    [
                        {
                            path: 'added.txt',
                            oldPath: undefined,
                            change: GitFileChange.Added,
                            insertions: 1,
                            deletions: 0,
                        },
                    ],
                ],
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects a base branch the repo lacks', async () => {
        const {folder} = await createRepo();
        try {
            await assert.throws(
                getPullRequestStatus({
                    folder,
                    baseBranch: 'missing',
                }),
            );
        } finally {
            await rm(folder, {
                force: true,
                recursive: true,
            });
        }
    });
});
