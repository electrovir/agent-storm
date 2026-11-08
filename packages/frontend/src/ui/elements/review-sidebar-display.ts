import {PrStatus, type ReviewQueue, type ReviewQueuePr} from '@agent-storm/common';
import {assertWrap} from '@augment-vir/assert';
import {getObjectTypedEntries, getObjectTypedValues, groupArrayBy} from '@augment-vir/common';
import {PrQueueKind} from '../../util/frontend-state.js';
import {prStatusTooltips} from '../../util/sidebar-display.js';

export type ReviewSidebarQueues = Readonly<
    Record<
        PrQueueKind,
        {
            /** Undefined until the server first answers, so the empty state doesn't flash. */
            queue: Readonly<ReviewQueue> | undefined;
            /** Why the server couldn't be reached. GitHub failures arrive in `queue.error` instead. */
            loadError: string | undefined;
        }
    >
>;

export type ReviewedRepo = Pick<ReviewQueuePr, 'owner' | 'repoName'>;

export function toRepoKey({owner, repoName}: Readonly<ReviewedRepo>) {
    return `${owner}/${repoName}`;
}

/** The Build sidebar's tooltips describe the viewer's own review, which an assignee doesn't give. */
const assigneePrStatusTooltips: Record<PrStatus, string> = {
    [PrStatus.None]: '',
    [PrStatus.AwaitingReview]: 'Awaiting review.',
    [PrStatus.ReviewStarted]: 'Review started.',
    [PrStatus.ReReviewRequested]: 'Awaiting re-review.',
    [PrStatus.UnresolvedComments]: 'Unresolved comments.',
    [PrStatus.ChangesRequested]: 'Changes requested.',
    [PrStatus.OthersRequestedChanges]: 'Changes requested.',
    [PrStatus.Approved]: 'Approved.',
    [PrStatus.AwaitingOtherReviews]: 'Waiting on other reviews.',
    [PrStatus.ChecksFailed]: 'Checks failed.',
    [PrStatus.ReadyToMerge]: 'Ready to merge.',
    [PrStatus.Merged]: 'Merged.',
    [PrStatus.Closed]: 'Closed without merging.',
};

/** The Reviewer tab only marks where the viewer's own review stands. */
const reviewerPrStatuses: ReadonlyArray<PrStatus> = [
    PrStatus.AwaitingReview,
    PrStatus.ReReviewRequested,
    PrStatus.ReviewStarted,
    PrStatus.Approved,
    PrStatus.ChangesRequested,
];

export const queuePrStatusDisplays: Record<
    PrQueueKind,
    {
        shownStatuses: ReadonlyArray<PrStatus>;
        tooltips: Record<PrStatus, string>;
    }
> = {
    [PrQueueKind.Review]: {
        shownStatuses: reviewerPrStatuses,
        tooltips: prStatusTooltips,
    },
    [PrQueueKind.Assignee]: {
        shownStatuses: getObjectTypedValues(PrStatus),
        tooltips: assigneePrStatusTooltips,
    },
};

export const prQueueTabs: Record<
    PrQueueKind,
    {
        label: string;
        emptyMessage: string;
    }
> = {
    [PrQueueKind.Review]: {
        label: 'Reviewer',
        emptyMessage: 'No pull requests are waiting on your review.',
    },
    [PrQueueKind.Assignee]: {
        label: 'Assignee',
        emptyMessage: 'No open pull requests are assigned to you.',
    },
};

/** PRs keep the server's order within each repo. */
export function groupByRepo(pullRequests: ReadonlyArray<ReviewQueuePr>) {
    return getObjectTypedEntries(
        groupArrayBy(pullRequests, toRepoKey, {
            useRequired: true,
        }),
    )
        .map(
            ([
                repo,
                repoPullRequests,
            ]) => {
                const firstPullRequest = assertWrap.isDefined(repoPullRequests[0]);
                return {
                    repo,
                    owner: firstPullRequest.owner,
                    repoName: firstPullRequest.repoName,
                    pullRequests: repoPullRequests,
                };
            },
        )
        .toSorted((first, second) => first.repo.localeCompare(second.repo));
}

export function openOnGitHub(pr: Readonly<ReviewQueuePr>) {
    globalThis.open(pr.url, '_blank', 'noopener');
}
