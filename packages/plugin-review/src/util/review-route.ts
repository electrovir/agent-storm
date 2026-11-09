import {type ReviewQueuePr} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {pullRequestRouteKey} from './pr-queues.js';

type PullRequestRef = Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number'>;

/** The Review activity's segments that select `pullRequest`. */
export function subPathsForPullRequest(pullRequest: Readonly<PullRequestRef>) {
    return [
        pullRequest.owner,
        pullRequest.repoName,
        String(pullRequest.number),
    ];
}

/**
 * The pull request the Review activity's segments select, keyed by `pullRequestRouteKey`, and the
 * keys of every PR that can be selected.
 *
 * `reviewablePrs` is undefined until the review queue loads, and while it is no pull request can be
 * selected.
 */
export function resolveReviewRoute({
    subPaths,
    reviewablePrs,
}: Readonly<{
    subPaths: ReadonlyArray<string>;
    reviewablePrs: ReadonlyArray<Readonly<PullRequestRef>> | undefined;
}>) {
    const reviewQueueKeys = reviewablePrs?.map((pr) => pullRequestRouteKey(pr));
    const routedPullRequest = check.isLengthExactly(subPaths, 3) ? subPaths.join('/') : undefined;
    return {
        /**
         * A PR that has left the review queue can't be selected, even from its URL. The cached
         * queue isn't enough to allow one: opening a PR that has since left would respawn its AI
         * pane.
         */
        activePullRequest:
            routedPullRequest && reviewQueueKeys?.includes(routedPullRequest)
                ? routedPullRequest
                : undefined,
        reviewQueueKeys,
    };
}
