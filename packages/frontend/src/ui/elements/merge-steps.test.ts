import {folderInfoShape, type FolderInfo} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {evaluateMergeStep, mergeStepsConfig} from './merge-steps.js';

const getApprovalStep = mergeStepsConfig.find((step) => step.name === 'get-approval');

/**
 * An open, non-draft PR that has not yet earned approval (review check not passing). Each test
 * overrides only the review-state fields it cares about so the "Get approval" step's failed /
 * loading verdict is driven solely by the scenario under test.
 */
function openPrAwaitingApproval(overrides: Partial<FolderInfo>): FolderInfo {
    return {
        ...folderInfoShape.default,
        prUrl: 'https://github.com/owner/repo/pull/1',
        prIsDraft: false,
        prMerged: false,
        prReviewCheckPassing: null,
        prReviewChangesRequested: false,
        prReviewPending: false,
        prHasUnresolvedReviewComments: false,
        prHasMergeConflicts: false,
        ...overrides,
    };
}

describe('get-approval step review state', () => {
    assert.isDefined(getApprovalStep);

    it('shows red exclam when a reviewer has requested feedback', () => {
        const folder = openPrAwaitingApproval({prReviewChangesRequested: true});
        const {failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isTrue(failed);
        assert.isFalse(loading);
    });

    it('shows red exclam when there is at least one unresolved comment', () => {
        const folder = openPrAwaitingApproval({prHasUnresolvedReviewComments: true});
        const {failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isTrue(failed);
        assert.isFalse(loading);
    });

    it('shows red exclam when the PR has merge conflicts', () => {
        const folder = openPrAwaitingApproval({prHasMergeConflicts: true});
        const {failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isTrue(failed);
        assert.isFalse(loading);
    });

    // A reviewer who previously requested changes but has since been re-requested is not a
    // current block. The server resolves this per-reviewer (see `hasActiveChangesRequested`) and
    // reports `prReviewChangesRequested: false`, so the step must fall back to loading rather than
    // red — even though GitHub still reports `reviewDecision: CHANGES_REQUESTED`.
    it('shows loading when the only changes-requested reviewer was re-requested', () => {
        const folder = openPrAwaitingApproval({
            prReviewChangesRequested: false,
            prReviewPending: true,
        });
        const {failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isFalse(failed);
        assert.isTrue(loading);
    });

    it('shows loading on an open PR with no outstanding review block', () => {
        const folder = openPrAwaitingApproval({});
        const {failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isFalse(failed);
        assert.isTrue(loading);
    });

    // app.example.com's "Check Review Status" gate reports FAILURE for the entire window before a
    // human approves, so `prReviewCheckPassing: false` is the ordinary waiting state, not a block.
    // Flagging it red made every unapproved PR show a red exclam.
    it('shows loading when the review check is failing only for lack of an approval', () => {
        const folder = openPrAwaitingApproval({
            prReviewCheckPassing: false,
            prReviewPending: true,
        });
        const {done, failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isFalse(done);
        assert.isFalse(failed);
        assert.isTrue(loading);
    });

    it('shows done once the review check passes', () => {
        const folder = openPrAwaitingApproval({prReviewCheckPassing: true});
        const {done, failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isTrue(done);
        assert.isFalse(failed);
        assert.isFalse(loading);
    });
});
