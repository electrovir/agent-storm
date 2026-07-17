import {type ReviewRequestedStatus} from '@agent-storm/common';
import {runGh} from './git.js';

/**
 * How long a fetched count is served before hitting GitHub again. The sidebar polls this endpoint
 * on its 2s refresh tick, so without a TTL cache every poll would burn a GitHub search-API call
 * (quota: 30/min). Five minutes keeps the counter fresh enough for a "PRs waiting on me" glance.
 */
const cacheTtlMs = 5 * 60 * 1_000;

const cacheState: {
    fetchedAtMs: number;
    status: ReviewRequestedStatus;
    inFlight: Promise<ReviewRequestedStatus> | undefined;
} = {
    fetchedAtMs: 0,
    status: {count: null},
    inFlight: undefined,
};

async function fetchCount(): Promise<ReviewRequestedStatus> {
    const result = await runGh([
        'api',
        '-X',
        'GET',
        'search/issues',
        '-f',
        'q=is:open is:pr review-requested:@me archived:false',
        '--jq',
        '.total_count',
    ]);
    if (result.exitCode !== 0) {
        return {count: null};
    }
    const parsed = Number.parseInt(result.stdout.trim(), 10);
    return {count: Number.isFinite(parsed) ? parsed : null};
}

/**
 * Count of open PRs awaiting the authenticated `gh` user's review, GitHub-wide. Cached for
 * {@link cacheTtlMs}; concurrent callers share one in-flight fetch. Returns `{count: null}` when
 * `gh` is unavailable/unauthenticated or the search fails — the sidebar hides its counter then.
 */
export async function getReviewRequestedStatus(): Promise<ReviewRequestedStatus> {
    if (Date.now() - cacheState.fetchedAtMs < cacheTtlMs) {
        return cacheState.status;
    }
    if (!cacheState.inFlight) {
        cacheState.inFlight = fetchCount()
            .then((status) => {
                cacheState.status = status;
                cacheState.fetchedAtMs = Date.now();
                return status;
            })
            .finally(() => {
                cacheState.inFlight = undefined;
            });
    }
    return await cacheState.inFlight;
}
