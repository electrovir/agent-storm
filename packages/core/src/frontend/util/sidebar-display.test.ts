import {folderInfoShape, PrStatus, type FolderInfo} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {getPrRingRank} from './sidebar-display.js';

function createFolder({
    prStatus,
    isDirty,
}: Readonly<{
    prStatus: PrStatus;
    isDirty: boolean;
}>): FolderInfo {
    return {
        ...folderInfoShape.default,
        prUrl: prStatus === PrStatus.None ? '' : 'https://github.com/owner/name/pull/1',
        prStatus,
        git: {
            ...folderInfoShape.default.git,
            dirty: isDirty,
        },
    };
}

describe(getPrRingRank.name, () => {
    it('ranks no PR below local changes, and local changes below every open PR ring', () => {
        assert.deepEquals(
            [
                createFolder({
                    prStatus: PrStatus.None,
                    isDirty: false,
                }),
                createFolder({
                    prStatus: PrStatus.Approved,
                    isDirty: true,
                }),
                createFolder({
                    prStatus: PrStatus.Approved,
                    isDirty: false,
                }),
                createFolder({
                    prStatus: PrStatus.Merged,
                    isDirty: true,
                }),
            ].map(getPrRingRank),
            [
                -1,
                0,
                1,
                11,
            ],
        );
    });
});
