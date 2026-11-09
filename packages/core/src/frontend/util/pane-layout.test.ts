import {DiffView, ManualReviewStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveDiffView, resolvePaneState} from './pane-layout.js';

const startedReview = {
    status: ManualReviewStatus.Started,
    isPending: false,
    lastUpdatedAt: 1,
};

describe(resolveDiffView.name, () => {
    const baseParams = {
        chosen: DiffView.ManualReview,
        hasChanges: true,
        reviewCopyFolder: undefined,
        review: undefined,
        isManualReviewStarting: false,
    } as const;

    it('falls back to a view with something to show', () => {
        assert.strictEquals(resolveDiffView(baseParams).diffView, DiffView.Source);
    });

    it('keeps a chosen manual review while it is starting or available', () => {
        assert.deepEquals(
            [
                resolveDiffView({
                    ...baseParams,
                    isManualReviewStarting: true,
                }).diffView,
                resolveDiffView({
                    ...baseParams,
                    hasChanges: false,
                    reviewCopyFolder: '/repos/copy',
                    review: startedReview,
                }).diffView,
            ],
            [
                DiffView.ManualReview,
                DiffView.ManualReview,
            ],
        );
    });
});

describe(resolvePaneState.name, () => {
    const shared = {
        selectedFolder: '/repos/app',
        diffView: DiffView.Source,
        diffSelections: {},
        activityPaths: [],
    };

    it('uses the tab’s own values over the shared ones', () => {
        assert.deepEquals(
            [
                resolvePaneState(shared, undefined),
                resolvePaneState(shared, {
                    state: {
                        diffView: DiffView.ManualReview,
                    },
                }),
            ],
            [
                shared,
                {
                    ...shared,
                    diffView: DiffView.ManualReview,
                },
            ],
        );
    });
});
