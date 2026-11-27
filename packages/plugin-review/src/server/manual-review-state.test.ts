// cspell:words fcwd
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {isInReviewFolder, parseLsofFolders} from './manual-review-state.js';

describe(parseLsofFolders.name, () => {
    it('pairs each pid with the path listed after it', () => {
        assert.deepEquals(
            parseLsofFolders(
                [
                    'p101',
                    'fcwd',
                    'n/reviews/owner/repo/1',
                    'p202',
                    'fcwd',
                    'n/reviews/owner/repo/2',
                    '',
                ].join('\n'),
            ),
            {
                '101': '/reviews/owner/repo/1',
                '202': '/reviews/owner/repo/2',
            },
        );
    });

    it('skips a path listed before any pid', () => {
        assert.deepEquals(
            parseLsofFolders(
                [
                    'n/orphan',
                    'p101',
                    'n/reviews/owner/repo/1',
                ].join('\n'),
            ),
            {
                '101': '/reviews/owner/repo/1',
            },
        );
    });
});

describe(isInReviewFolder.name, () => {
    it('counts the folder itself and its subfolders, but not a sibling', () => {
        assert.deepEquals(
            [
                '/reviews/owner/repo/1',
                '/reviews/owner/repo/1/src',
                '/reviews/owner/repo/12',
            ].map((cwd) => {
                return isInReviewFolder({
                    folder: '/reviews/owner/repo/1',
                    cwd,
                });
            }),
            [
                true,
                true,
                false,
            ],
        );
    });
});
