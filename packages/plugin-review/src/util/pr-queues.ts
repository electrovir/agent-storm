import {reviewQueueResponseShape, type ReviewQueue, type ReviewQueuePr} from '@agent-storm/common';
import {defineSetting} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getObjectTypedValues,
    mapObjectValues,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {Observable} from 'element-vir';
import {checkValidShape} from 'object-shape-tester';
import {
    getVerdictPrStatus,
    hasRecentVerdict,
    toRepoKey,
    type PrReviews,
    type ReviewedRepo,
} from './pr-reviews.js';
import {reviewClient} from './review-client.js';

/** The PR lists the Review sidebar switches between. */
export enum PrQueueKind {
    Review = 'review',
    Assignee = 'assignee',
}

/** The Review plugin's server call that reads each queue. */
const prQueueCalls: Readonly<Record<PrQueueKind, 'readReviewQueue' | 'readAssigneeQueue'>> = {
    [PrQueueKind.Review]: 'readReviewQueue',
    [PrQueueKind.Assignee]: 'readAssigneeQueue',
};

/** The server's last answer for each queue, shown on startup until it answers again. */
const prQueueCaches = mapObjectValues(prQueueCalls, (kind) => {
    return defineSetting<ReviewQueue | undefined>({
        key: `agent-storm:review:${kind}-queue-cache`,
        defaultValue: undefined,
        parse(raw) {
            const parsed: unknown = JSON.parse(raw);
            return checkValidShape(parsed, reviewQueueResponseShape) ? parsed : undefined;
        },
        serialize(value) {
            return value && JSON.stringify(value);
        },
    });
});

/**
 * Identifies a PR by number, the way the review route does (`owner/repoName/number`). Not
 * interchangeable with core's `reviewPrKey`, which keys by branch.
 */
export function pullRequestRouteKey({
    owner,
    repoName,
    number,
}: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number'>>) {
    return [
        owner,
        repoName,
        number,
    ].join('/');
}

export type PrQueues = Record<
    PrQueueKind,
    {
        /**
         * The server's queue from this page load. Undefined until it first answers. Unlike the
         * cached copy, this is current enough to decide which pull requests can be selected.
         */
        queue: ReviewQueue | undefined;
        /** The last page load's queue, shown until `queue` loads. */
        cachedQueue: ReviewQueue | undefined;
        /** Why the server couldn't be reached. GitHub failures arrive in `queue.error` instead. */
        loadError: string | undefined;
    }
>;

export type PrQueuesObservable = ReturnType<typeof createPrQueues>;

/**
 * Each queue as it should be shown: this page load's copy, else the cached one, with each PR's
 * status replaced by a just-sent verdict's. A Reviewer list PR with a just-sent verdict moves to
 * its already-reviewed list, since GitHub keeps the review request until the skill posts the
 * review.
 */
export function getShownPrQueues({
    prQueues,
    prReviews,
}: Readonly<{
    prQueues: Readonly<PrQueues>;
    prReviews: Readonly<PrReviews>;
}>) {
    return mapObjectValues(prQueues, (kind, {queue, cachedQueue, loadError}) => {
        const shownQueue = queue || cachedQueue;
        const verdictSentPrs =
            kind === PrQueueKind.Review && shownQueue
                ? shownQueue.pullRequests.filter((pr) => {
                      return hasRecentVerdict({
                          prReviews,
                          url: pr.url,
                          /** The skill posts the review well after the click. */
                          within: {
                              minutes: 15,
                          },
                      });
                  })
                : [];
        return {
            queue: shownQueue && {
                ...shownQueue,
                reviewedPullRequests: verdictSentPrs.length
                    ? [
                          ...verdictSentPrs,
                          ...(shownQueue.reviewedPullRequests || []),
                      ]
                    : shownQueue.reviewedPullRequests,
                pullRequests: shownQueue.pullRequests
                    .filter((pr) => !verdictSentPrs.includes(pr))
                    .map((pr) => {
                        return {
                            ...pr,
                            prStatus:
                                getVerdictPrStatus({
                                    prReviews,
                                    url: pr.url,
                                    prStatus: pr.prStatus,
                                }) || pr.prStatus,
                        };
                    }),
            },
            loadError,
        };
    });
}

/**
 * The PRs that can be selected for review, from this page load's queues only. Undefined until the
 * Review queue first answers.
 */
export function getReviewablePrs(prQueues: Readonly<PrQueues>) {
    return (
        prQueues[PrQueueKind.Review].queue && [
            ...prQueues[PrQueueKind.Review].queue.pullRequests,
            ...(prQueues[PrQueueKind.Review].queue.reviewedPullRequests || []),
            ...(prQueues[PrQueueKind.Assignee].queue?.pullRequests || []),
        ]
    );
}

/** Every repo with a pull request in any queue, each once, sorted by `owner/repoName`. */
export function listQueueRepos(prQueues: Readonly<PrQueues>) {
    const repos = getObjectTypedValues(prQueues).flatMap(({queue, cachedQueue}) => {
        const shownQueue = queue || cachedQueue;
        return [
            ...(shownQueue?.pullRequests || []),
            ...(shownQueue?.reviewedPullRequests || []),
        ].map((pullRequest): ReviewedRepo => {
            return {
                owner: pullRequest.owner,
                repoName: pullRequest.repoName,
            };
        });
    });
    return repos
        .filter((repo, index) => {
            return repos.findIndex((other) => toRepoKey(other) === toRepoKey(repo)) === index;
        })
        .toSorted((first, second) => toRepoKey(first).localeCompare(toRepoKey(second)));
}

/** The server's PR queues. Nothing loads until `startPolling`. */
export function createPrQueues() {
    const observable = new Observable<PrQueues>({
        defaultValue: mapObjectValues(prQueueCaches, (_kind, cache) => {
            return {
                queue: undefined,
                cachedQueue: cache.read(),
                loadError: undefined,
            };
        }),
    });

    function updatePrQueue({
        kind,
        ...queueUpdate
    }: Readonly<
        Partial<PrQueues[PrQueueKind]> & {
            kind: PrQueueKind;
        }
    >) {
        const updatedQueue = {
            ...observable.value[kind],
            ...queueUpdate,
        };
        /** Every poll answers with a fresh copy, which would otherwise re-render every listener. */
        if (check.deepEquals(updatedQueue, observable.value[kind])) {
            return;
        }
        observable.setValue({
            ...observable.value,
            [kind]: updatedQueue,
        });
    }

    async function loadPrQueue({
        kind,
        forceRefresh,
    }: Readonly<
        {
            kind: PrQueueKind;
        } & PartialWithUndefined<{
            forceRefresh: boolean;
        }>
    >) {
        try {
            const queue = await reviewClient.call(prQueueCalls[kind], {
                forceRefresh: !!forceRefresh,
            });
            updatePrQueue({
                kind,
                queue,
                loadError: undefined,
            });
            if (!check.deepEquals(observable.value[kind].cachedQueue, queue)) {
                prQueueCaches[kind].write(queue);
                updatePrQueue({
                    kind,
                    cachedQueue: queue,
                });
            }
        } catch (error) {
            updatePrQueue({
                kind,
                loadError: extractErrorMessage(error),
            });
        }
    }

    function loadAllPrQueues() {
        getObjectTypedValues(PrQueueKind).forEach((kind) => {
            void loadPrQueue({
                kind,
            });
        });
    }

    return Object.assign(observable, {
        /**
         * Loads the queues now and then keeps polling them, so the Review tab's count is available
         * from any tab. Returns the poll's remover.
         */
        startPolling() {
            loadAllPrQueues();
            /**
             * The server decides when GitHub is actually queried, so this only bounds how far the
             * shown queues lag behind the server's.
             */
            const pollHandle = setInterval(
                () => {
                    loadAllPrQueues();
                },
                convertDuration(
                    {
                        seconds: 5,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            );
            return () => {
                clearInterval(pollHandle);
            };
        },
        async forceRefresh(kind: PrQueueKind) {
            const queue = observable.value[kind].queue;
            /** Shows the spinner right away instead of after the next poll. */
            updatePrQueue({
                kind,
                queue: queue && {
                    ...queue,
                    isUpdating: true,
                },
            });
            await loadPrQueue({
                kind,
                forceRefresh: true,
            });
        },
    });
}
