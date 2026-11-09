import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {resolveReviewRoute, subPathsForPullRequest} from './review-route.js';

const pullRequest = {
    owner: 'acme',
    repoName: 'widgets',
    number: 7,
};

describe(resolveReviewRoute.name, () => {
    it('only selects a pull request that is still reviewable', () => {
        assert.deepEquals(
            [
                resolveReviewRoute({
                    subPaths: subPathsForPullRequest(pullRequest),
                    reviewablePrs: [
                        pullRequest,
                    ],
                }),
                resolveReviewRoute({
                    subPaths: subPathsForPullRequest({
                        ...pullRequest,
                        number: 8,
                    }),
                    reviewablePrs: [
                        pullRequest,
                    ],
                }),
                resolveReviewRoute({
                    subPaths: subPathsForPullRequest(pullRequest),
                    reviewablePrs: undefined,
                }),
            ].map(({activePullRequest}) => activePullRequest),
            [
                'acme/widgets/7',
                undefined,
                undefined,
            ],
        );
    });
});
