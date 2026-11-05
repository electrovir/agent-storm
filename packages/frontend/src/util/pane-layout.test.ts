import {ManualReviewStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {FrontendTab} from './frontend-tab.js';
import {DiffView, resolveDiffView, resolvePaneLayout} from './pane-layout.js';

const startedReview = {
    status: ManualReviewStatus.Started,
    isPending: false,
    lastUpdatedAt: 1,
};

describe(resolvePaneLayout.name, () => {
    const baseParams = {
        activeTab: FrontendTab.Ai,
        isMobile: false,
        isReviewFolder: false,
        hasPr: false,
        review: undefined,
    } as const;

    it('shows both terminals side by side on desktop and one at a time on mobile', () => {
        assert.deepEquals(
            [
                resolvePaneLayout(baseParams),
                resolvePaneLayout({
                    ...baseParams,
                    isMobile: true,
                }),
            ].map(({showAiPane, showShellPane, mountShellTerminal, tabButtons}) => {
                return {
                    showAiPane,
                    showShellPane,
                    mountShellTerminal,
                    tabs: tabButtons.map(({label}) => label),
                };
            }),
            [
                {
                    showAiPane: true,
                    showShellPane: true,
                    mountShellTerminal: true,
                    tabs: [
                        'CLI',
                        'Diff',
                    ],
                },
                {
                    showAiPane: true,
                    showShellPane: false,
                    mountShellTerminal: false,
                    tabs: [
                        'AI',
                        'Shell',
                        'Diff',
                    ],
                },
            ],
        );
    });

    it('holds back a review folder diff until its review has started', () => {
        assert.deepEquals(
            [
                undefined,
                {
                    ...startedReview,
                    isPending: true,
                },
                startedReview,
            ].map((review) => {
                const layout = resolvePaneLayout({
                    ...baseParams,
                    activeTab: FrontendTab.Diff,
                    isReviewFolder: true,
                    review,
                });
                return {
                    isDiffTab: layout.isDiffTab,
                    isReviewPaneTab: layout.isReviewPaneTab,
                };
            }),
            [
                {
                    isDiffTab: false,
                    isReviewPaneTab: true,
                },
                {
                    isDiffTab: false,
                    isReviewPaneTab: true,
                },
                {
                    isDiffTab: true,
                    isReviewPaneTab: false,
                },
            ],
        );
    });
});

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
