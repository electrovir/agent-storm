import {DiffView} from '@agent-storm/common';
import {
    addTab,
    createTabId,
    diffPaneId,
    findShownTabIdOfKind,
    PaneMounting,
    reviewPaneId,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideScanEyeIcon} from 'vira';
import {VirPaneReview} from './vir-pane-review.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';

function renderReview(params: PaneRenderParams) {
    return html`
        <${VirPaneReview.assign({
            folder: params.folder,
            paneReview: params.paneReview,
            prReviews: params.context.prReviews,
            isMobile: params.isMobile,
            initialPromptSentAt: params.reviewStart?.reviewUpdatedAt,
        })}
            ${listen(VirReviewPane.events.manualReviewStarted, () => {
                if (params.isReviewFolder) {
                    return;
                }
                params.writeLayout((current) => {
                    const diffTabId =
                        findShownTabIdOfKind(current, diffPaneId) || createTabId(diffPaneId);
                    return updateTabState(
                        addTab(current, {
                            tab: {
                                id: diffTabId,
                                kind: diffPaneId,
                            },
                            isBackground: true,
                        }),
                        {
                            tabId: diffTabId,
                            state: {
                                diffView: DiffView.ManualReview,
                            },
                        },
                    );
                });
                params.setManualReviewStarting(true);
            })}
        ></${VirPaneReview}>
    `;
}

/** A tab reviewing the folder's pull request with its AI. */
export const reviewPane: PaneDefinition = {
    id: reviewPaneId,
    label() {
        return 'Review';
    },
    newTabEntries() {
        return [
            {
                label: 'Review',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideScanEyeIcon, 14),
    hasAi: false,
    mounting: PaneMounting.Always,
    isAvailable() {
        return true;
    },
    render: renderReview,
};
