import {diffPaneId, DiffView, PaneKind, reviewPaneId, type DiffTabState} from '@agent-storm/common';
import {
    addTab,
    createTabId,
    DefaultTabPosition,
    findExtensionRun,
    findShownTabIdOfKind,
    noTabStateShape,
    PaneMounting,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideScanEyeIcon} from 'vira';
import {isReviewFolder, reviewExtension} from '../../util/review-extension.js';
import {findReviewState} from '../../util/review-state.js';
import {VirPaneReview} from './vir-pane-review.element.js';
import {VirReviewPane} from './vir-review-pane.element.js';

function renderReview(params: PaneRenderParams) {
    const paneReview = findExtensionRun(params, reviewExtension);
    return html`
        <${VirPaneReview.assign({
            folder: params.folder,
            isReviewFolder: isReviewFolder(params),
            paneReview,
            prReviews: findReviewState(params.context).prReviews,
            isMobile: params.isMobile,
        })}
            ${listen(VirReviewPane.events.manualReviewStarted, () => {
                if (isReviewFolder(params)) {
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
                            } satisfies Partial<DiffTabState>,
                        },
                    );
                });
                paneReview.setManualReviewStarting(true);
            })}
        ></${VirPaneReview}>
    `;
}

/** A tab reviewing the folder's pull request with its AI. */
export const reviewPane: PaneDefinition = {
    id: reviewPaneId,
    tabStateShape: noTabStateShape,
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
    defaultPlacement(view) {
        return {
            group: PaneKind.Shell,
            position: isReviewFolder(view) ? DefaultTabPosition.Start : DefaultTabPosition.End,
        };
    },
};
