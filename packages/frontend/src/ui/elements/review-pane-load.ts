import {type ReviewQueuePr} from '@agent-storm/common';
import {type FrontendStateObservable} from '../../util/frontend-state.js';

/**
 * Same as `frontendState.loadReviewPr`, but takes a whole PR: `loadReviewPr` sends every field it
 * doesn't recognize on to the server, so this picks out the ones that identify the PR.
 */
export async function loadReviewPanePr({
    frontendState,
    pullRequest,
    forceRefresh,
}: Readonly<{
    frontendState: FrontendStateObservable | undefined;
    pullRequest: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number' | 'branchName'>>;
    forceRefresh: boolean;
}>) {
    await frontendState?.loadReviewPr({
        owner: pullRequest.owner,
        repoName: pullRequest.repoName,
        number: pullRequest.number,
        branchName: pullRequest.branchName,
        forceRefresh,
    });
}
