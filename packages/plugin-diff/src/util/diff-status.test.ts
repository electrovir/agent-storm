import {GitDiffSide, GitFileChange, type GitDiffFile} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {findSelected, nextSideValue, reselectValue, toSelectValue} from './diff-status.js';

function createFile(path: string): GitDiffFile {
    return {
        path,
        change: GitFileChange.Modified,
        oldPath: null,
        insertions: 1,
        deletions: 0,
    };
}

const status = {
    staged: [
        createFile('staged.ts'),
    ],
    unstaged: [
        createFile('first.ts'),
        createFile('second.ts'),
        createFile('third.ts'),
    ],
};

describe(findSelected.name, () => {
    it('reads the file from the list its side names', () => {
        assert.deepEquals(
            [
                findSelected(status, toSelectValue(GitDiffSide.Staged, 'staged.ts')),
                findSelected(status, toSelectValue(GitDiffSide.Unstaged, 'staged.ts')),
                findSelected(status, toSelectValue(GitDiffSide.Unstaged, 'second.ts')),
            ],
            [
                {
                    side: GitDiffSide.Staged,
                    file: createFile('staged.ts'),
                },
                undefined,
                {
                    side: GitDiffSide.Unstaged,
                    file: createFile('second.ts'),
                },
            ],
        );
    });
    it('rejects a value whose side is not a known side', () => {
        assert.isUndefined(
            findSelected(
                status,
                [
                    'bogus',
                    'first.ts',
                ].join('\0'),
            ),
        );
    });
});

describe(reselectValue.name, () => {
    it('follows a file to the other side before falling back to the first file', () => {
        const values = [
            toSelectValue(GitDiffSide.Staged, 'other.ts'),
            toSelectValue(GitDiffSide.Staged, 'first.ts'),
        ];
        assert.deepEquals(
            [
                reselectValue(toSelectValue(GitDiffSide.Unstaged, 'first.ts'), values),
                reselectValue(toSelectValue(GitDiffSide.Unstaged, 'gone.ts'), values),
            ],
            [
                toSelectValue(GitDiffSide.Staged, 'first.ts'),
                toSelectValue(GitDiffSide.Staged, 'other.ts'),
            ],
        );
    });
});

describe(nextSideValue.name, () => {
    it('opens the neighbor that slides into the moved file’s place', () => {
        assert.deepEquals(
            [
                nextSideValue(status, {
                    side: GitDiffSide.Unstaged,
                    file: createFile('second.ts'),
                }),
                nextSideValue(status, {
                    side: GitDiffSide.Unstaged,
                    file: createFile('third.ts'),
                }),
                nextSideValue(status, {
                    side: GitDiffSide.Staged,
                    file: createFile('staged.ts'),
                }),
            ],
            [
                toSelectValue(GitDiffSide.Unstaged, 'third.ts'),
                toSelectValue(GitDiffSide.Unstaged, 'second.ts'),
                undefined,
            ],
        );
    });
});
