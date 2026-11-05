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
 * Records one PR fetched outside its repo's lookup. The repo's `fetchedAt` is left alone, so its
 * own lookup still refreshes on schedule.
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
    repoPrCache.set(key, {
        fetchedAt: repoPrCache.get(key)?.fetchedAt || 0,
        prsByBranch: new Map([
            ...(repoPrCache.get(key)?.prsByBranch || []),
            [
                branchName,
                prInfo,
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
    return prInfo?.url === url ? prInfo.status : undefined;
}
