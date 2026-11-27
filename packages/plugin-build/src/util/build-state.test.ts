// cspell:words unpushed
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {describeArchiveLoss} from './build-state.js';

const baseParams = {
    branch: 'feature',
    cwd: '/repos/name/feature',
};

describe(describeArchiveLoss.name, () => {
    it('says nothing is lost for a clean branch with no commits of its own', () => {
        assert.strictEquals(
            describeArchiveLoss({
                ...baseParams,
                changes: {
                    hasUncommittedChanges: false,
                    branchCommitCount: 0,
                    unpushedCommitCount: 0,
                },
            }),
            'Archiving this thread also deletes its worktree.\n\n/repos/name/feature\n\nNothing will be lost: there are no uncommitted changes, and the branch "feature" has no commits of its own. Archive?',
        );
    });
    it('counts local-only commits and uncommitted changes', () => {
        assert.strictEquals(
            describeArchiveLoss({
                ...baseParams,
                changes: {
                    hasUncommittedChanges: true,
                    branchCommitCount: 3,
                    unpushedCommitCount: 2,
                },
            }),
            'Archiving this thread also deletes its worktree, but its branch "feature" hasn\'t been merged yet.\n\n/repos/name/feature\n\nIts uncommitted changes will be lost. The branch stays, but 2 of its commits only exist locally. Archive anyway?',
        );
    });
    it('says pushed commits stay', () => {
        assert.strictEquals(
            describeArchiveLoss({
                ...baseParams,
                changes: {
                    hasUncommittedChanges: false,
                    branchCommitCount: 3,
                    unpushedCommitCount: 0,
                },
            }),
            'Archiving this thread also deletes its worktree, but its branch "feature" hasn\'t been merged yet.\n\n/repos/name/feature\n\nThe branch stays, and its commits are pushed. Archive anyway?',
        );
    });
});
