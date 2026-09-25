import {folderInfoShape, PaneStatus, type FolderInfo} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {evaluateMergeStep, isWorking, mergeStepsConfig} from './merge-steps.js';

const getApprovalStep = mergeStepsConfig.find((step) => step.name === 'get-approval');

/**
 * An open, non-draft PR that has not yet earned approval. Each test overrides only the review-state
 * fields it cares about so the "Get approval" step's failed / loading verdict is driven solely by
 * the scenario under test.
 */
function openPrAwaitingApproval(overrides: Partial<FolderInfo>): FolderInfo {
    return {
        ...folderInfoShape.default,
        prUrl: 'https://github.com/owner/repo/pull/1',
        prIsDraft: false,
        prMerged: false,
        prApproved: false,
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

    it('shows done once a reviewer approves', () => {
        const folder = openPrAwaitingApproval({prApproved: true});
        const {done, failed, loading} = evaluateMergeStep(folder, getApprovalStep);
        assert.isTrue(done);
        assert.isFalse(failed);
        assert.isFalse(loading);
    });
});

describe(isWorking.name, () => {
    const withAiPane = (ai: PaneStatus, overrides: Partial<FolderInfo>) =>
        openPrAwaitingApproval({
            ...overrides,
            panes: {...folderInfoShape.default.panes, ai},
        });

    it('is working while the AI generates and CI passes', () => {
        assert.isTrue(isWorking(withAiPane(PaneStatus.Busy, {prCiPassing: true})));
    });

    it('is working while the AI generates even though CI failed', () => {
        assert.isTrue(isWorking(withAiPane(PaneStatus.Busy, {prCiPassing: false})));
    });

    it('is working while the AI generates even though a reviewer requested changes', () => {
        assert.isTrue(isWorking(withAiPane(PaneStatus.Busy, {prReviewChangesRequested: true})));
    });

    it('is working while waiting on approval with CI passing', () => {
        assert.isTrue(
            isWorking(withAiPane(PaneStatus.Idle, {prCiPassing: true, prApproved: false})),
        );
    });

    it('is working while CI is still running', () => {
        assert.isTrue(
            isWorking(withAiPane(PaneStatus.Idle, {prCiPassing: null, prCiInProgress: true})),
        );
    });

    it('needs attention when CI failed and the AI is idle', () => {
        assert.isFalse(isWorking(withAiPane(PaneStatus.Idle, {prCiPassing: false})));
    });

    it('needs attention when a reviewer requested changes and the AI is idle', () => {
        assert.isFalse(
            isWorking(
                withAiPane(PaneStatus.Idle, {prCiPassing: true, prReviewChangesRequested: true}),
            ),
        );
    });

    it('needs attention once approved with CI passing and the AI idle', () => {
        assert.isFalse(
            isWorking(withAiPane(PaneStatus.Idle, {prCiPassing: true, prApproved: true})),
        );
    });

    it('needs attention with no PR and the AI idle', () => {
        assert.isFalse(isWorking(withAiPane(PaneStatus.Idle, {prUrl: null})));
    });
});
