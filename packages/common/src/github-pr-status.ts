import {check} from '@augment-vir/assert';
import {removeDuplicates, type Overwrite} from '@augment-vir/common';
import {defineShape, enumShape, nullableShape, optionalShape} from 'object-shape-tester';
import {PrStatus} from './enums.js';
import {
    failedCheckResults,
    RawCheckResult,
    RawMergeState,
    RawPrState,
    RawReviewDecision,
    RawReviewState,
} from './github-raw-enums.js';

/** One open PR as the server's repo PRs GraphQL query and the review queue's query fetch it. */
export const openPrNodeShape = defineShape({
    url: '',
    headRefName: '',
    baseRefName: '',
    headRefOid: '',
    /** ISO time. */
    updatedAt: '',
    state: enumShape(RawPrState),
    mergeStateStatus: '',
    reviewDecision: nullableShape(''),
    body: '',
    author: nullableShape({
        login: '',
    }),
    headRef: nullableShape({
        /** Empty when the branch points at something other than a commit. */
        target: nullableShape({
            statusCheckRollup: optionalShape(
                nullableShape({
                    state: '',
                }),
            ),
        }),
    }),
    latestOpinionatedReviews: {
        nodes: [
            {
                state: '',
                viewerDidAuthor: false,
                author: nullableShape({
                    login: '',
                }),
            },
        ],
    },
    viewerLatestReviewRequest: nullableShape({
        id: '',
    }),
    viewerDidAuthor: false,
    reviewThreads: {
        nodes: [
            {
                isResolved: false,
            },
        ],
    },
});

export type OpenPrNode = typeof openPrNodeShape.runtimeType;

/** The verdict each review state gives. Undefined still awaits one. */
const viewerReviewPrStatuses: Readonly<Record<RawReviewState, PrStatus | undefined>> = {
    [RawReviewState.Approved]: PrStatus.Approved,
    [RawReviewState.ChangesRequested]: PrStatus.ChangesRequested,
    [RawReviewState.Commented]: undefined,
    [RawReviewState.Dismissed]: undefined,
    [RawReviewState.Pending]: undefined,
};

/**
 * Review-vir's `parseInsertedCodeOwners`: the logins pull-request-vir lists in the code owners
 * block it writes into a PR's raw markdown body. `undefined` when there's no block.
 */
export function parseInsertedCodeOwners(body: string) {
    const block = /<!-- code owners start -->([\S\s]*?)<!-- code owners end -->/i.exec(body)?.[1];
    if (block == undefined) {
        return undefined;
    }
    /** Owned-file link lines are dropped so scoped paths (`@types/...`) aren't read as owners. */
    const ownerLines = block
        .split('\n')
        .filter((line) => !/^\s*-\s/.test(line))
        .join('\n');
    return removeDuplicates(
        Array.from(ownerLines.matchAll(/@[\w-]+/g)).map((tag) => tag[0].slice(1)),
    );
}

/**
 * GitHub drops the viewer's review request once they submit a review, so a request that exists
 * means they never reviewed it or were asked to look again.
 *
 * Reads `latestOpinionatedReviews` rather than `viewerLatestReview`: replying to a review thread
 * files a comment-only review, which `viewerLatestReview` would return in place of an approval.
 */
export function toOpenPrStatus({
    mergeStateStatus,
    reviewDecision,
    body,
    author,
    headRef,
    latestOpinionatedReviews,
    viewerLatestReviewRequest,
    viewerDidAuthor,
    reviewThreads,
}: Readonly<
    Overwrite<
        Pick<
            OpenPrNode,
            | 'mergeStateStatus'
            | 'reviewDecision'
            | 'body'
            | 'author'
            | 'headRef'
            | 'viewerLatestReviewRequest'
            | 'viewerDidAuthor'
        >,
        {
            latestOpinionatedReviews: Readonly<{
                nodes: ReadonlyArray<OpenPrNode['latestOpinionatedReviews']['nodes'][number]>;
            }>;
            reviewThreads: Readonly<{
                nodes: ReadonlyArray<OpenPrNode['reviewThreads']['nodes'][number]>;
            }>;
        }
    >
>) {
    const reviews = latestOpinionatedReviews.nodes;
    const viewerReviewState = reviews.find((review) => review.viewerDidAuthor)?.state;
    /** GitHub doesn't let a PR's author approve or request changes on it. */
    const viewerVerdict =
        !viewerDidAuthor && check.isEnumValue(viewerReviewState, RawReviewState)
            ? viewerReviewPrStatuses[viewerReviewState]
            : undefined;
    const rollupState = headRef?.target?.statusCheckRollup?.state;
    const hasUnresolvedThread = reviewThreads.nodes.some((thread) => !thread.isResolved);
    const isViewerSignedOff = viewerDidAuthor || viewerVerdict === PrStatus.Approved;
    const isViewerDone = isViewerSignedOff && !hasUnresolvedThread;
    /** Pull-request-vir skips the author's own rules and counts only approvals. */
    const hasUnapprovedCodeOwner = (parseInsertedCodeOwners(body) || []).some((owner) => {
        return (
            owner.toLowerCase() !== author?.login.toLowerCase() &&
            !reviews.some((review) => {
                return (
                    review.state === RawReviewState.Approved &&
                    review.author?.login.toLowerCase() === owner.toLowerCase()
                );
            })
        );
    });
    /**
     * `CLEAN` only means GitHub would allow the merge, which it does with the viewer's review
     * request still open when the repo doesn't require reviews.
     */
    if (viewerLatestReviewRequest) {
        return viewerVerdict === PrStatus.ChangesRequested
            ? PrStatus.ReReviewRequested
            : PrStatus.AwaitingReview;
    } else if (mergeStateStatus === RawMergeState.Clean) {
        return PrStatus.ReadyToMerge;
    } else if (
        isViewerSignedOff &&
        reviews.some((review) => {
            return !review.viewerDidAuthor && review.state === RawReviewState.ChangesRequested;
        })
    ) {
        return PrStatus.OthersRequestedChanges;
    } else if (
        isViewerDone &&
        /**
         * Pull-request-vir enforces code-owner review with a CI check rather than GitHub's own
         * rule, which leaves `reviewDecision` at `APPROVED` while a code owner still hasn't.
         */
        (reviewDecision === RawReviewDecision.ReviewRequired || hasUnapprovedCodeOwner)
    ) {
        return PrStatus.AwaitingOtherReviews;
    } else if (
        isViewerDone &&
        check.isEnumValue(rollupState, RawCheckResult) &&
        failedCheckResults[rollupState]
    ) {
        return PrStatus.ChecksFailed;
    } else if (viewerVerdict === PrStatus.ChangesRequested) {
        return viewerVerdict;
    } else {
        return hasUnresolvedThread
            ? PrStatus.UnresolvedComments
            : viewerVerdict || PrStatus.AwaitingReview;
    }
}
