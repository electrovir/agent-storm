import {diffPaneId, reviewPaneId, type ReviewQueuePr} from '@agent-storm/common';
import {
    hasTabOfKind,
    type PaneGroupExtension,
    type PaneGroupExtensionInputs,
    type PaneGroupView,
} from '@agent-storm/core/frontend';
import {createPaneReview, type PaneReviewObservable} from './pane-review.js';
import {findReviewState} from './review-state.js';

/** Set by the Review stage on a pull request's review folder's pane group. */
export type ReviewExtensionInputs = Readonly<{
    pullRequest: Readonly<ReviewQueuePr>;
}>;

/** The pane group's PR and manual review, which the Diff and Review panes both read. */
export const reviewExtension: PaneGroupExtension<ReviewExtensionInputs, PaneReviewObservable> = {
    id: 'review',
    create({folder, context, folderSessions}) {
        return createPaneReview({
            folder,
            uiLayout: context.uiLayout,
            folderSessions,
            prReviews: findReviewState(context).prReviews,
        });
    },
    sync({run, inputs, view, displayedTabIds, shownTabIds, hasPr}) {
        const isDiffDisplayed = hasTabOfKind(view.layout, {
            tabIds: displayedTabIds,
            kind: diffPaneId,
        });
        const isReviewDisplayed = hasTabOfKind(view.layout, {
            tabIds: displayedTabIds,
            kind: reviewPaneId,
        });
        run.sync({
            active: view.isActive,
            hasPr,
            isPrNeeded: isDiffDisplayed || isReviewDisplayed,
            isReviewPaneOpen: isReviewDisplayed && view.isActive,
            isDiffMounted:
                hasTabOfKind(view.layout, {
                    tabIds: shownTabIds,
                    kind: diffPaneId,
                }) || isDiffDisplayed,
            reviewPullRequest: inputs?.pullRequest,
        });
    },
};

/** Passes `pullRequest` to a pane group, which makes its folder a review folder. */
export function createReviewExtensionInputs(
    pullRequest: Readonly<ReviewQueuePr>,
): PaneGroupExtensionInputs {
    return {
        [reviewExtension.id]: {
            pullRequest,
        } satisfies ReviewExtensionInputs,
    };
}

/** Whether the pane group is a pull request's review folder rather than a Build folder. */
export function isReviewFolder(view: Readonly<Pick<PaneGroupView, 'extensionInputs'>>) {
    return !!view.extensionInputs[reviewExtension.id];
}
