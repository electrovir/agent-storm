import {
    diffPaneId,
    diffTabStateShape,
    DiffView,
    ManualReviewStatus,
    type DiffTabState,
    type ManualReviewState,
} from '@agent-storm/common';
import {
    findExtensionRun,
    PaneMounting,
    resolveTabState,
    updateTabState,
    type PaneDefinition,
    type PaneRenderParams,
} from '@agent-storm/core/frontend';
import {isReviewFolder, reviewExtension} from '@agent-storm/plugin-review';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {html, listen} from 'element-vir';
import {createSizedIcon, LucideFileDiffIcon, ViraDropdown} from 'vira';
import {findDiffPlacement} from '../../util/diff-placement.js';
import {resolveDiffView} from '../../util/diff-view.js';
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

function renderDiff(params: PaneRenderParams<typeof diffTabStateShape>) {
    const paneReview = findExtensionRun(params, reviewExtension);
    const info = params.context.folderData.value.folderInfo.get(params.folder);
    const diff = resolveDiffView({
        chosen: params.tabState.diffView,
        hasChanges: !!info?.git.dirty,
        reviewCopyFolder: paneReview.value.reviewCopyFolder,
        review: paneReview.value.review,
        isManualReviewStarting: paneReview.value.isManualReviewStarting,
    });
    if (paneReview.value.isManualReviewStarting && diff.isAvailable[DiffView.ManualReview]) {
        paneReview.setManualReviewStarting(false);
    }
    const isViewSelectable: Readonly<Record<DiffView, boolean>> = {
        [DiffView.Source]: diff.isAvailable[DiffView.Source],
        [DiffView.ManualReview]: diff.isManualReviewSelectable,
    };

    return html`
        <${VirPaneDiff.assign({
            folder: params.folder,
            isShown: params.isDisplayed && params.isActive,
            diffView: diff.diffView,
            diffSelections: params.tabState.diffSelections,
            paneReview,
            isReviewCopyReady: diff.isAvailable[DiffView.ManualReview],
            isReviewFolder: isReviewFolder(params),
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
                                    } satisfies Partial<DiffTabState>,
                                });
                            });
                            paneReview.setManualReviewStarting(false);
                        }
                    })}
                ></${ViraDropdown}>
            `,
        })}
            ${listen(VirPaneDiff.events.diffSelectionChange, (event) => {
                params.writeLayout((current) => {
                    const {diffSelections} = resolveTabState({
                        tabStateShape: diffTabStateShape,
                        tabState: current.tabs[params.tabId]?.state,
                    });
                    return updateTabState(current, {
                        tabId: params.tabId,
                        state: {
                            diffSelections: {
                                ...diffSelections,
                                [event.detail.diffView]: {
                                    ...diffSelections[event.detail.diffView],
                                    ...event.detail.selection,
                                },
                            },
                        } satisfies Partial<DiffTabState>,
                    });
                });
            })}
        ></${VirPaneDiff}>
    `;
}

/** A tab showing the folder's changes, or its manual review's. */
export const diffPane: PaneDefinition<typeof diffTabStateShape> = {
    id: diffPaneId,
    tabStateShape: diffTabStateShape,
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
        return (
            !isReviewFolder(view) ||
            isReviewFolderDiffAvailable(findExtensionRun(view, reviewExtension).value.review)
        );
    },
    defaultPlacement: findDiffPlacement,
    render: renderDiff,
};
