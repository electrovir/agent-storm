import {folderInfoShape, type FolderInfo} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveBuildFolder, subPathsForFolder} from './build-route.js';

function createFolder(overrides: Readonly<Partial<FolderInfo>>): FolderInfo {
    return {
        ...folderInfoShape.default,
        ...overrides,
    };
}

const standalone = createFolder({
    path: '/repos/solo',
    name: 'solo',
});
const worktreeRoot = createFolder({
    path: '/repos/multi',
    name: 'multi',
    isWorktreeRoot: true,
});
const worktree = createFolder({
    path: '/repos/multi/feature',
    name: 'feature',
    parentRepoPath: worktreeRoot.path,
});
const folderInfo = new Map(
    [
        standalone,
        worktreeRoot,
        worktree,
    ].map((folder) => {
        return [
            folder.path,
            folder,
        ];
    }),
);

describe(resolveBuildFolder.name, () => {
    it('selects a standalone repo and a worktree from their segments', () => {
        assert.deepEquals(
            [
                ['solo'],
                [
                    'multi',
                    'feature',
                ],
            ].map((subPaths) => {
                const {folder, isInvalid} = resolveBuildFolder(subPaths, folderInfo);
                return {
                    folder: folder?.path,
                    isInvalid,
                };
            }),
            [
                {
                    folder: standalone.path,
                    isInvalid: false,
                },
                {
                    folder: worktree.path,
                    isInvalid: false,
                },
            ],
        );
    });

    it('rejects a worktree root on its own, but not before folders load', () => {
        assert.deepEquals(
            [
                resolveBuildFolder(['multi'], folderInfo).isInvalid,
                resolveBuildFolder(['multi'], new Map()).isInvalid,
            ],
            [
                true,
                false,
            ],
        );
    });
});

describe(subPathsForFolder.name, () => {
    it('round-trips through resolveBuildFolder', () => {
        assert.deepEquals(
            [
                standalone,
                worktree,
            ].map((folder) => {
                return resolveBuildFolder(subPathsForFolder(folder, folderInfo), folderInfo).folder
                    ?.path;
            }),
            [
                standalone.path,
                worktree.path,
            ],
        );
    });
});
