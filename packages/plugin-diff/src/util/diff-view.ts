import {DiffView, type ManualReviewState} from '@agent-storm/common';
import {canPostVerdictByStatus} from '@agent-storm/plugin-review';
import {getObjectTypedValues} from '@augment-vir/common';

/**
 * The view a Diff tab shows: `chosen` when it has something to show, else whichever view does, else
 * Source. A chosen ManualReview view is kept while `isManualReviewStarting`, so the tab stays on it
 * while the review copy is still being made.
 */
export function resolveDiffView({
    chosen,
    hasChanges,
    reviewCopyFolder,
    review,
    isManualReviewStarting,
}: Readonly<{
    chosen: DiffView;
    /** Whether the folder has any uncommitted change, staged or not. */
    hasChanges: boolean;
    reviewCopyFolder: string | undefined;
    review: Readonly<ManualReviewState> | undefined;
    isManualReviewStarting: boolean;
}>) {
    const isAvailable: Readonly<Record<DiffView, boolean>> = {
        [DiffView.Source]: hasChanges,
        /** A copy left over from an earlier review would otherwise show a finished review. */
        [DiffView.ManualReview]:
            !!reviewCopyFolder && !!review && canPostVerdictByStatus[review.status],
    };
    const isManualReviewSelectable = isAvailable[DiffView.ManualReview] || isManualReviewStarting;
    return {
        diffView:
            isAvailable[chosen] || (chosen === DiffView.ManualReview && isManualReviewSelectable)
                ? chosen
                : getObjectTypedValues(DiffView).find((view) => isAvailable[view]) ||
                  DiffView.Source,
        isAvailable,
        isManualReviewSelectable,
    };
}
