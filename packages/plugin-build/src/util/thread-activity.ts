import {PrStatus} from '@agent-storm/common';
import {type Thread, ThreadStatus} from '../build-api.js';

/** Whether the sidebar shows `thread` with a spinner: its AI or its background tasks still work. */
export function isThreadWorking(thread: Readonly<Pick<Thread, 'status' | 'backgroundTaskCount'>>) {
    return (
        thread.status === ThreadStatus.Running ||
        (thread.status === ThreadStatus.Idle && !!thread.backgroundTaskCount)
    );
}

/** PR statuses that wait on the viewer's own review. */
export const isAwaitingViewerReview: Readonly<Record<PrStatus, boolean>> = {
    [PrStatus.None]: false,
    [PrStatus.AwaitingReview]: true,
    [PrStatus.ReviewStarted]: true,
    [PrStatus.ReReviewRequested]: true,
    [PrStatus.UnresolvedComments]: false,
    [PrStatus.ChangesRequested]: false,
    [PrStatus.Approved]: false,
    [PrStatus.OthersRequestedChanges]: false,
    [PrStatus.AwaitingOtherReviews]: false,
    [PrStatus.ChecksFailed]: false,
    [PrStatus.ReadyToMerge]: false,
    [PrStatus.Merged]: false,
    [PrStatus.Closed]: false,
};
