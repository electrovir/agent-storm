import {PrStatus} from '@agent-storm/common';
import {filterObject} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {type PrInfo, type RepoSlug} from './git.js';

type RepoPrCacheEntry = {
    fetchedAt: number;
    prsByBranch: Map<string, PrInfo>;
};

/**
 * Every PR the server knows about, by repo and then head branch. The Build tab's per-repo lookups
 * and the Review tab's queues both write here and both read from here, so the two tabs always show
 * whichever GitHub answer landed last.
 *
 * Key: `${owner}/${name}`. See {@link repoCacheKey}.
 */
export const repoPrCache = new Map<string, RepoPrCacheEntry>();

export function repoCacheKey(slug: Readonly<RepoSlug>) {
    return `${slug.owner}/${slug.name}`;
}

/**
 * The GitHub statuses each status held by {@link holdPrStatus} stands in for: the ones GitHub still
 * answers with before it shows the change. Any other answer means GitHub caught up.
 */
const heldStatusReplacements: Readonly<Record<PrStatus, ReadonlyArray<PrStatus>>> = {
    [PrStatus.None]: [],
    [PrStatus.AwaitingReview]: [],
    [PrStatus.ReviewStarted]: [],
    [PrStatus.ReReviewRequested]: [],
    [PrStatus.UnresolvedComments]: [],
    [PrStatus.ChangesRequested]: [
        PrStatus.AwaitingReview,
        PrStatus.ReviewStarted,
        PrStatus.ReReviewRequested,
        PrStatus.UnresolvedComments,
        PrStatus.Approved,
        PrStatus.AwaitingOtherReviews,
        PrStatus.ChecksFailed,
        PrStatus.ReadyToMerge,
    ],
    /** Unresolved threads outrank an approval, as they do in GitHub's own status. */
    [PrStatus.Approved]: [
        PrStatus.AwaitingReview,
        PrStatus.ReviewStarted,
        PrStatus.ReReviewRequested,
        PrStatus.ChangesRequested,
    ],
    [PrStatus.OthersRequestedChanges]: [],
    [PrStatus.AwaitingOtherReviews]: [],
    [PrStatus.ChecksFailed]: [],
    [PrStatus.ReadyToMerge]: [],
    [PrStatus.Merged]: [],
    [PrStatus.Closed]: [],
};

/** By PR url. */
const heldPrStatuses = new Map<
    string,
    Readonly<{
        status: PrStatus;
        heldAt: number;
    }>
>();

/**
 * Shows `status` for the PR at `url` in place of the cached GitHub answers that predate it, for a
 * change made in agent-storm that GitHub doesn't show yet. An undefined `status` drops the hold.
 */
export function holdPrStatus({
    url,
    status,
}: Readonly<{
    url: string;
    status: PrStatus | undefined;
}>) {
    if (status) {
        heldPrStatuses.set(url, {
            status,
            heldAt: Date.now(),
        });
    } else {
        heldPrStatuses.delete(url);
    }
}

/**
 * `prInfo` with the status held for its PR by {@link holdPrStatus}. A GitHub answer that caught up,
 * or a hold GitHub never confirmed, ends the hold.
 */
export function applyHeldPrStatus(prInfo: Readonly<PrInfo>) {
    const held = heldPrStatuses.get(prInfo.url);
    if (!held) {
        return prInfo;
    }
    const isHeld =
        heldStatusReplacements[held.status].includes(prInfo.status) &&
        Date.now() - held.heldAt <
            convertDuration(
                {
                    minutes: 15,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds;
    if (!isHeld) {
        heldPrStatuses.delete(prInfo.url);
        return prInfo;
    }
    return {
        ...prInfo,
        status: held.status,
    };
}

/**
 * Records one PR fetched outside its repo's lookup. The repo's `fetchedAt` is left alone, so its
 * own lookup still refreshes on schedule. Fields `prInfo` leaves undefined keep their recorded
 * value while the branch's recorded PR is the same PR.
 */
export function recordBranchPr({
    owner,
    name,
    branchName,
    prInfo,
}: Readonly<
    RepoSlug & {
        branchName: string;
        prInfo: Readonly<PrInfo>;
    }
>) {
    const key = repoCacheKey({
        owner,
        name,
    });
    const recorded = repoPrCache.get(key)?.prsByBranch.get(branchName);
    repoPrCache.set(key, {
        fetchedAt: repoPrCache.get(key)?.fetchedAt || 0,
        prsByBranch: new Map([
            ...(repoPrCache.get(key)?.prsByBranch || []),
            [
                branchName,
                {
                    ...prInfo,
                    ...(recorded?.url === prInfo.url ? recorded : undefined),
                    ...filterObject(prInfo, (_key, value) => value !== undefined),
                },
            ],
        ]),
    });
}

/** Undefined when the branch's recorded PR isn't the PR at `url`. */
export function readBranchPrStatus({
    owner,
    name,
    branchName,
    url,
}: Readonly<
    RepoSlug & {
        branchName: string;
        url: string;
    }
>) {
    const prInfo = repoPrCache
        .get(
            repoCacheKey({
                owner,
                name,
            }),
        )
        ?.prsByBranch.get(branchName);
    return prInfo?.url === url ? applyHeldPrStatus(prInfo).status : undefined;
}
