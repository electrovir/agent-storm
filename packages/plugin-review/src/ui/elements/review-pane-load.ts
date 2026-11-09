import {type ReviewQueuePr} from '@agent-storm/common';
import {type PrReviewsObservable} from '../../util/pr-reviews.js';

/**
 * Same as `prReviews.loadReviewPr`, but takes a whole PR: `loadReviewPr` sends every field it
 * doesn't recognize on to the server, so this picks out the ones that identify the PR.
 */
export async function loadReviewPanePr({
    prReviews,
    pullRequest,
    forceRefresh,
}: Readonly<{
    prReviews: PrReviewsObservable;
    pullRequest: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number' | 'branchName'>>;
    forceRefresh: boolean;
}>) {
    await prReviews.loadReviewPr({
        owner: pullRequest.owner,
        repoName: pullRequest.repoName,
        number: pullRequest.number,
        branchName: pullRequest.branchName,
        forceRefresh,
    });
}
