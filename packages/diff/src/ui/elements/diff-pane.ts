import {DiffView, ManualReviewStatus, type ManualReviewState} from '@agent-storm/common';
import {
    diffPaneId,
    PaneMounting,
    resolveDiffView,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideFileDiffIcon, ViraDropdown} from 'vira';
import {VirPaneDiff} from './vir-pane-diff.element.js';

/** Before a review folder's review branch exists, its diff is meaningless or empty. */
function isReviewFolderDiffAvailable(review: Readonly<ManualReviewState> | undefined) {
    return (
        !!review &&
        review.status !== ManualReviewStatus.Aborted &&
        !(review.status === ManualReviewStatus.Started && review.isPending)
    );
}

const diffViewLabels: Readonly<Record<DiffView, string>> = {
    [DiffView.Source]: 'Source',
    [DiffView.ManualReview]: 'Manual review',
};

function renderDiff(params: PaneRenderParams) {
    const info = params.context.folderData.value.folderInfo.get(params.folder);
    const diff = resolveDiffView({
        chosen: params.paneState.diffView,
        hasChanges: !!info?.git.dirty,
        reviewCopyFolder: params.paneReview.value.reviewCopyFolder,
        review: params.review,
        isManualReviewStarting: params.isManualReviewStarting,
    });
    if (params.isManualReviewStarting && diff.isAvailable[DiffView.ManualReview]) {
        params.setManualReviewStarting(false);
    }
    const isViewSelectable: Readonly<Record<DiffView, boolean>> = {
        [DiffView.Source]: diff.isAvailable[DiffView.Source],
        [DiffView.ManualReview]: diff.isManualReviewSelectable,
    };

    return html`
        <${VirPaneDiff.assign({
            folder: params.paneState.selectedFolder,
            isShown: params.isDisplayed && params.isActive,
            diffView: diff.diffView,
            diffSelections: params.paneState.diffSelections,
            paneReview: params.paneReview,
            isReviewCopyReady: diff.isAvailable[DiffView.ManualReview],
            isReviewFolder: params.isReviewFolder,
            screenSize: params.context.screenSize,
            sourcePicker: html`
                <${ViraDropdown.assign({
                    options: getEnumValues(DiffView).map((view) => {
                        return {
                            value: view,
                            label: diffViewLabels[view],
                            disabled: !isViewSelectable[view],
                        };
                    }),
                    selected: [
                        diff.diffView,
                    ],
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        const view = event.detail[0];
                        if (check.isEnumValue(view, DiffView)) {
                            params.writeLayout((current) => {
                                return updateTabState(current, {
                                    tabId: params.tabId,
                                    state: {
                                        diffView: view,
                                    },
                                });
                            });
                            params.setManualReviewStarting(false);
                        }
                    })}
                ></${ViraDropdown}>
            `,
        })}
            ${listen(VirPaneDiff.events.diffSelectionChange, (event) => {
                params.writeLayout((current) => {
                    const diffSelections = current.tabs[params.tabId]?.state?.diffSelections;
                    return updateTabState(current, {
                        tabId: params.tabId,
                        state: {
                            diffSelections: {
                                ...diffSelections,
                                [event.detail.diffView]: {
                                    ...diffSelections?.[event.detail.diffView],
                                    ...event.detail.selection,
                                },
                            },
                        },
                    });
                });
            })}
        ></${VirPaneDiff}>
    `;
}

/** A tab showing the folder's changes, or its manual review's. */
export const diffPane: PaneDefinition = {
    id: diffPaneId,
    label() {
        return 'Diff';
    },
    newTabEntries() {
        return [
            {
                label: 'Diff',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideFileDiffIcon, 14),
    hasAi: false,
    /** The diff costs nothing while hidden (no socket, no subprocess). */
    mounting: PaneMounting.OnceDisplayed,
    isAvailable(view) {
        return !view.isReviewFolder || isReviewFolderDiffAvailable(view.review);
    },
    render: renderDiff,
};
