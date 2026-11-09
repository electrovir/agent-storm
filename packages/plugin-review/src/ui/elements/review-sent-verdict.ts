import {GitHubReviewState, type ReviewPr} from '@agent-storm/common';
import {createUtcFullDate, toUtcIsoString} from 'date-vir';
import {reviewVerdicts, type PrReviews} from '../../util/pr-reviews.js';

/** Reviews drawn as a colored bar across the timeline rather than a card. */
export const verdictReviewStates: ReadonlyArray<GitHubReviewState> = [
    GitHubReviewState.Approved,
    GitHubReviewState.ChangesRequested,
];

/**
 * Shows a verdict sent from agent-storm as the viewer's review until GitHub returns one at least as
 * new. The skill posts it well after the click, and the PR isn't fetched again on its own.
 */
export function withSentVerdict(
    details: Readonly<ReviewPr>,
    sentVerdict: PrReviews['verdicts'][string],
) {
    if (
        !sentVerdict ||
        details.reviews.some((review) => {
            return (
                verdictReviewStates.includes(review.state) &&
                Date.parse(review.createdAt) >= sentVerdict.requestedAt
            );
        })
    ) {
        return details;
    }
    const state = reviewVerdicts[sentVerdict.verdict].reviewState;
    return {
        ...details,
        reviewers: [
            ...details.reviewers.filter((reviewer) => reviewer.login !== details.viewer.login),
            {
                login: details.viewer.login,
                avatarUrl: details.viewer.avatarUrl,
                state,
            },
        ].toSorted((first, second) => first.login.localeCompare(second.login)),
        reviews: [
            ...details.reviews,
            {
                id: `sent-verdict-${sentVerdict.requestedAt}`,
                author: details.viewer.login,
                authorAvatarUrl: details.viewer.avatarUrl,
                state,
                body: '',
                bodyHtml: '',
                createdAt: toUtcIsoString(createUtcFullDate(sentVerdict.requestedAt)),
                url: details.url,
            },
        ],
    };
}
