import {
    closeEditorWindowEndpoint,
    gitHubAssigneeQueueEndpoint,
    gitHubReviewPrEndpoint,
    gitHubReviewQueueEndpoint,
    GitHubReviewState,
    PrStatus,
    reviewQueueResponseShape,
    type FolderInfo,
    type ReviewPr,
    type ReviewQueue,
    type ReviewQueuePr,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getObjectTypedValues,
    mapObjectValues,
    omitObjectKeys,
    typedObjectFromEntries,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, type AnyDuration} from 'date-vir';
import {Observable} from 'element-vir';
import {LocalDbClient, LocalDbClientValueUpdateEvent} from 'local-db-client';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';
import {fetchApi} from './api-client.js';
import {reportClientError} from './client-error-log.js';

/** The PR lists the Review sidebar switches between. */
export enum PrQueueKind {
    Review = 'review',
    Assignee = 'assignee',
}

/** Each queue's endpoint: `GET` reads the backend's cached copy, `POST` re-fetches it from GitHub. */
const prQueueEndpoints = {
    [PrQueueKind.Review]: gitHubReviewQueueEndpoint,
    [PrQueueKind.Assignee]: gitHubAssigneeQueueEndpoint,
} satisfies Record<PrQueueKind, unknown>;

/** The order the Review pane lists a PR's previous conversations in. */
export enum ConversationSortOrder {
    NewestFirst = 'newest-first',
    OldestFirst = 'oldest-first',
}

export enum ReviewVerdict {
    Approve = 'approve',
    RequestChanges = 'request-changes',
}

export const reviewVerdicts: Record<
    ReviewVerdict,
    {
        /** Typed into the AI pane, where the manual-review skill posts the review. */
        prompt: string;
        /** What the PR's rings show as soon as the verdict is sent. */
        prStatus: PrStatus;
        /** The viewer's review the Review pane shows until GitHub returns the posted one. */
        reviewState: GitHubReviewState;
    }
> = {
    [ReviewVerdict.Approve]: {
        prompt: '/manual-review approve',
        prStatus: PrStatus.Approved,
        reviewState: GitHubReviewState.Approved,
    },
    [ReviewVerdict.RequestChanges]: {
        prompt: '/manual-review request-changes',
        prStatus: PrStatus.ChangesRequested,
        reviewState: GitHubReviewState.ChangesRequested,
    },
};

/** How long a sent verdict's status is shown in place of GitHub's, which lags behind it. */
const verdictOverrideDuration: AnyDuration = {
    minutes: 2,
};

type ReviewedBranch = Pick<ReviewQueuePr, 'owner' | 'repoName' | 'branchName'>;

/**
 * Keys {@link FrontendState.reviewPrs} by branch, so a Build folder and its PR's review share one
 * entry. Not interchangeable with {@link pullRequestRouteKey}, which keys by PR number.
 */
export function reviewPrKey({owner, repoName, branchName}: Readonly<ReviewedBranch>) {
    return `${owner}/${repoName}>${branchName}`;
}

/**
 * Identifies a PR by number, the way the review route does (`owner/repoName/number`). Not
 * interchangeable with {@link reviewPrKey}, which keys by branch.
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

/** Which local db entry holds each queue's last answer. */
const prQueueCacheKeys = {
    [PrQueueKind.Review]: 'reviewQueueCache',
    [PrQueueKind.Assignee]: 'assigneeQueueCache',
} as const satisfies Record<PrQueueKind, string>;

async function createLocalDbClient() {
    return await LocalDbClient.createClient(
        {
            /** The Build tab's memory, restored whenever the tab opens with nothing selected. */
            build: {
                shape: defineShape({
                    /** Absolute path of the last selected folder. */
                    selectedFolder: nullableShape(''),
                }),
            },
            /** The Review tab's memory, restored whenever the tab opens with nothing selected. */
            review: {
                shape: defineShape({
                    /** {@link pullRequestRouteKey} of the last selected pull request. */
                    selectedPullRequest: nullableShape(''),
                    /** The sidebar list that was showing last. */
                    selectedQueue: nullableShape(enumShape(PrQueueKind)),
                    /** Shared by every PR's Review pane. Empty means newest first. */
                    conversationSortOrder: nullableShape(enumShape(ConversationSortOrder)),
                }),
            },
            /**
             * The server's last Reviewer list, shown on startup until it answers again. Each queue
             * has its own entry because a write replaces the whole entry only once IndexedDB
             * finishes, so two queues sharing one entry overwrite each other's fresh copy.
             */
            reviewQueueCache: {
                shape: reviewQueueResponseShape,
            },
            /** Same as `reviewQueueCache`, for the Assignee list. */
            assigneeQueueCache: {
                shape: reviewQueueResponseShape,
            },
        },
        {
            storeName: 'agent-storm',
        },
    );
}

export type FrontendState = {
    localDbClient: Awaited<ReturnType<typeof createLocalDbClient>>;
    prQueues: Record<
        PrQueueKind,
        {
            /**
             * The server's queue from this page load. Undefined until it first answers. Unlike the
             * local db's cached copy, this is current enough to decide which pull requests can be
             * selected.
             */
            queue: ReviewQueue | undefined;
            /** Why the server couldn't be reached. GitHub failures arrive in `queue.error` instead. */
            loadError: string | undefined;
        }
    >;
    /**
     * The Review pane's PR details, by {@link reviewPrKey}, so the Build and Review tabs show the
     * same copy of a branch's PR.
     */
    reviewPrs: Readonly<
        Record<
            string,
            | Readonly<{
                  number: number;
                  /** Undefined until the first fetch of this PR lands. */
                  details: ReviewPr | undefined;
                  isRefreshing: boolean;
                  loadError: string;
              }>
            | undefined
        >
    >;
    /** Approvals and change requests sent from either tab, by PR url. */
    verdicts: Readonly<
        Record<
            string,
            | Readonly<{
                  verdict: ReviewVerdict;
                  prStatus: PrStatus;
                  requestedAt: number;
              }>
            | undefined
        >
    >;
};

export type FrontendStateObservable = Awaited<ReturnType<typeof createFrontendState>>;

/**
 * Each queue as it should be shown: this page load's copy, else the cached one, with each PR's
 * status replaced by a just-sent verdict's (see {@link getVerdictPrStatus}).
 */
export function getShownPrQueues(frontendState: Readonly<FrontendState>) {
    return mapObjectValues(frontendState.prQueues, (kind, {queue, loadError}) => {
        const shownQueue =
            queue || frontendState.localDbClient.value[prQueueCacheKeys[kind]] || undefined;
        return {
            queue: shownQueue && {
                ...shownQueue,
                pullRequests: shownQueue.pullRequests.map((pr) => {
                    return {
                        ...pr,
                        prStatus:
                            getVerdictPrStatus({
                                frontendState,
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
export function getReviewablePrs({prQueues}: Readonly<Pick<FrontendState, 'prQueues'>>) {
    /** Matches the server's `resolveReviewFolder`: the viewer's own PRs can't be reviewed. */
    return (
        prQueues[PrQueueKind.Review].queue && [
            ...prQueues[PrQueueKind.Review].queue.pullRequests,
            ...(prQueues[PrQueueKind.Assignee].queue?.pullRequests.filter((pr) => {
                return !pr.isViewerAuthor;
            }) || []),
        ]
    );
}

/**
 * {@link getVerdictPrStatus} for each folder whose branch has a PR, by folder path. Folders without
 * a just-sent verdict are left out.
 */
export function getFolderVerdictStatuses({
    frontendState,
    folderInfo,
}: Readonly<{
    frontendState: Readonly<FrontendState>;
    folderInfo: ReadonlyMap<string, Readonly<FolderInfo>>;
}>) {
    return typedObjectFromEntries(
        [...folderInfo].flatMap(
            ([
                folderPath,
                info,
            ]) => {
                const prStatus =
                    info.prUrl &&
                    getVerdictPrStatus({
                        frontendState,
                        url: info.prUrl,
                        prStatus: info.prStatus,
                    });
                return prStatus
                    ? [
                          [
                              folderPath,
                              prStatus,
                          ] as const,
                      ]
                    : [];
            },
        ),
    );
}

/**
 * The status a verdict sent for the PR at `url` will leave it in, while GitHub may not show it yet.
 * Undefined otherwise, including while the PR's polled `prStatus` shows unresolved comments, which
 * outrank an approval.
 */
function getVerdictPrStatus({
    frontendState,
    url,
    prStatus,
}: Readonly<{
    frontendState: Readonly<FrontendState>;
    url: string;
    prStatus: PrStatus;
}>) {
    const verdict = frontendState.verdicts[url];
    return verdict &&
        (prStatus !== PrStatus.UnresolvedComments ||
            verdict.prStatus === PrStatus.ChangesRequested) &&
        Date.now() - verdict.requestedAt <
            convertDuration(verdictOverrideDuration, {
                milliseconds: true,
            }).milliseconds
        ? verdict.prStatus
        : undefined;
}

/**
 * App-wide frontend state. Starts polling the server's PR queues right away, so the Review tab's
 * count is available from any tab.
 */
export async function createFrontendState() {
    const localDbClient = await createLocalDbClient();
    const observable = new Observable<FrontendState>({
        /** The default deep check throws on `localDbClient`'s symbol keys. */
        equalityCheck: check.strictEquals,
        defaultValue: {
            localDbClient,
            prQueues: mapObjectValues(prQueueEndpoints, () => {
                return {
                    queue: undefined,
                    loadError: undefined,
                };
            }),
            reviewPrs: {},
            verdicts: {},
        },
    });
    const destroyObservable = observable.destroy.bind(observable);

    function update(updateValue: Partial<FrontendState> = {}) {
        observable.setValue({
            ...observable.value,
            ...updateValue,
        });
    }

    function updatePrQueue({
        kind,
        ...queueUpdate
    }: Readonly<
        Partial<FrontendState['prQueues'][PrQueueKind]> & {
            kind: PrQueueKind;
        }
    >) {
        const updatedQueue = {
            ...observable.value.prQueues[kind],
            ...queueUpdate,
        };
        /** Every poll answers with a fresh copy, which would otherwise re-render every listener. */
        if (check.deepEquals(updatedQueue, observable.value.prQueues[kind])) {
            return;
        }
        update({
            prQueues: {
                ...observable.value.prQueues,
                [kind]: updatedQueue,
            },
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
            const queue = await fetchApi(
                prQueueEndpoints[kind],
                forceRefresh ? HttpMethod.Post : HttpMethod.Get,
            );
            updatePrQueue({
                kind,
                queue,
                loadError: undefined,
            });
            const cachedQueue = localDbClient.value[prQueueCacheKeys[kind]];
            if (!cachedQueue || !check.deepEquals(queue, cachedQueue)) {
                await localDbClient.set[prQueueCacheKeys[kind]](queue);
            }
        } catch (error) {
            updatePrQueue({
                kind,
                loadError: extractErrorMessage(error),
            });
        }
    }

    function updateReviewPr({
        key,
        ...reviewPr
    }: Readonly<
        NonNullable<FrontendState['reviewPrs'][string]> & {
            key: string;
        }
    >) {
        update({
            reviewPrs: {
                ...observable.value.reviewPrs,
                [key]: reviewPr,
            },
        });
    }

    function loadAllPrQueues() {
        getObjectTypedValues(PrQueueKind).forEach((kind) => {
            void loadPrQueue({
                kind,
            });
        });
    }

    /**
     * The latest `loadReviewPr` call per {@link reviewPrKey}, so an earlier call that answers late
     * doesn't overwrite a newer one's result.
     */
    const latestReviewPrRequests = new Map<string, number>();

    async function recordVerdict({
        pullRequest,
        verdict,
    }: Readonly<{
        pullRequest: Readonly<ReviewedBranch & Pick<ReviewQueuePr, 'url'>>;
        verdict: ReviewVerdict;
    }>) {
        update({
            verdicts: {
                ...observable.value.verdicts,
                [pullRequest.url]: {
                    verdict,
                    prStatus: reviewVerdicts[verdict].prStatus,
                    requestedAt: Date.now(),
                },
            },
        });
        try {
            await fetchApi(closeEditorWindowEndpoint, HttpMethod.Post, {
                requestData: {
                    owner: pullRequest.owner,
                    repoName: pullRequest.repoName,
                    branchName: pullRequest.branchName,
                },
            });
        } catch (error) {
            reportClientError({
                error,
                source: 'closeEditorWindow',
            });
        }
    }

    const removeLocalDbListener = localDbClient.listen(LocalDbClientValueUpdateEvent, () => {
        update();
    });
    loadAllPrQueues();
    /**
     * The server decides when GitHub is actually queried, so this only bounds how far the shown
     * queues lag behind the server's.
     */
    const prQueuePollHandle = setInterval(
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

    return Object.assign(observable, {
        update,
        async forceRefreshPrQueue(kind: PrQueueKind) {
            const queue = observable.value.prQueues[kind].queue;
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
        async loadReviewPr({
            number,
            forceRefresh,
            ...branch
        }: Readonly<
            ReviewedBranch & {
                number: number;
                forceRefresh: boolean;
            }
        >) {
            const key = reviewPrKey(branch);
            const requestId = (latestReviewPrRequests.get(key) ?? 0) + 1;
            latestReviewPrRequests.set(key, requestId);
            const previous = observable.value.reviewPrs[key];
            const details = previous?.number === number ? previous.details : undefined;
            updateReviewPr({
                key,
                number,
                details,
                isRefreshing: true,
                loadError: '',
            });
            try {
                const fetchedDetails = await fetchApi(gitHubReviewPrEndpoint, HttpMethod.Post, {
                    requestData: {
                        ...branch,
                        number,
                        forceRefresh,
                    },
                });
                if (latestReviewPrRequests.get(key) !== requestId) {
                    return;
                }
                updateReviewPr({
                    key,
                    number,
                    details: fetchedDetails,
                    isRefreshing: false,
                    loadError: '',
                });
            } catch (error) {
                if (latestReviewPrRequests.get(key) !== requestId) {
                    return;
                }
                updateReviewPr({
                    key,
                    number,
                    details,
                    isRefreshing: false,
                    loadError: extractErrorMessage(error),
                });
            }
        },
        /**
         * Hands the verdict's prompt to `sendPrompt`, which types it into the PR's AI pane for the
         * manual-review skill to post. Meanwhile shows the verdict's status everywhere the PR is
         * listed, and closes the editor window the review was read in, without waiting for the
         * skill.
         */
        async requestVerdict({
            sendPrompt,
            ...verdictRequest
        }: Readonly<
            Parameters<typeof recordVerdict>[0] & {
                sendPrompt: (prompt: string) => Promise<void>;
            }
        >) {
            await Promise.all([
                recordVerdict(verdictRequest),
                sendPrompt(reviewVerdicts[verdictRequest.verdict].prompt),
            ]);
        },
        /** For a verdict the skill failed to post. */
        clearVerdict(url: string) {
            update({
                verdicts: omitObjectKeys(observable.value.verdicts, [
                    url,
                ]),
            });
        },
        destroy() {
            clearInterval(prQueuePollHandle);
            removeLocalDbListener();
            destroyObservable();
        },
    });
}
