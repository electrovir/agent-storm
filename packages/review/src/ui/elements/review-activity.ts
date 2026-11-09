import {defineActivity, localStorageClient, type AppContext} from '@agent-storm/core/frontend';
import {getObjectTypedValues} from '@augment-vir/common';
import {html, Observable} from 'element-vir';
import {
    createPrQueues,
    getReviewablePrs,
    getShownPrQueues,
    PrQueueKind,
    pullRequestRouteKey,
    type PrQueues,
} from '../../util/pr-queues.js';
import {reviewMemory} from '../../util/review-memory.js';
import {resolveReviewRoute, subPathsForPullRequest} from '../../util/review-route.js';
import {VirReviewQueueSidebar} from './vir-review-queue-sidebar.element.js';
import {VirReviewStage} from './vir-review-stage.element.js';

function resolveRoute(prQueues: Readonly<PrQueues>, subPaths: ReadonlyArray<string>) {
    return resolveReviewRoute({
        subPaths,
        reviewablePrs: getReviewablePrs(prQueues),
    });
}

function findShownPrQueues({
    context,
    prQueues,
}: Readonly<{
    context: AppContext;
    prQueues: Readonly<PrQueues>;
}>) {
    return getShownPrQueues({
        prQueues,
        prReviews: context.prReviews.value,
    });
}

/** Pull requests waiting on the user, each reviewed in its own folder's panes. */
export const reviewActivity = defineActivity({
    id: 'review',
    label: 'Review',
    isEnabledByDefault: true,
    createState() {
        return {
            prQueues: createPrQueues(),
            /**
             * The Review tab's list. Undefined until picked this session, so the stored pick can
             * load later.
             */
            queue: new Observable<PrQueueKind | undefined>({
                defaultValue: undefined,
            }),
            /**
             * Set to a new object each time the user selects a PR, which clears that PR's review
             * folder error so the folder is asked for again. Notifies on every set, since each new
             * object is a new retry.
             */
            retry: new Observable<Readonly<{key: string}> | undefined>({
                equalityCheck: undefined,
                defaultValue: undefined,
            }),
        };
    },
    mobileMenuTitle: 'Review requests',
    sidebar: {
        widthSetting: localStorageClient.reviewSidebarWidth,
        render({context, state, route}) {
            return html`
                <${VirReviewQueueSidebar.assign({
                    context,
                    route,
                    activePullRequest: resolveRoute(state.prQueues.value, route.subPaths)
                        .activePullRequest,
                    prQueues: state.prQueues,
                    queue: state.queue,
                    retry: state.retry,
                })}></${VirReviewQueueSidebar}>
            `;
        },
    },
    isKeptMounted: true,
    render({context, state, route, isShown}) {
        return html`
            <${VirReviewStage.assign({
                context,
                subPaths: route.subPaths,
                ...resolveRoute(state.prQueues.value, route.subPaths),
                isShown,
                retry: state.retry,
            })}></${VirReviewStage}>
        `;
    },
    findCount({context, state}) {
        return findShownPrQueues({
            context,
            prQueues: state.prQueues.value,
        })[PrQueueKind.Review].queue?.pullRequests.length;
    },
    findRestoredSubPaths({state}) {
        const rememberedKey = reviewMemory.selectedPullRequest.read();
        const pullRequest =
            rememberedKey &&
            getReviewablePrs(state.prQueues.value)?.find((pr) => {
                return pullRequestRouteKey(pr) === rememberedKey;
            });
        return pullRequest ? subPathsForPullRequest(pullRequest) : undefined;
    },
    findRedirect({subPaths}) {
        return subPaths.length && subPaths.length !== 3 ? [] : undefined;
    },
    startWithApp({state}) {
        return state.prQueues.startPolling();
    },
    renderInDashboard({context, state, route}) {
        const queues = findShownPrQueues({
            context,
            prQueues: state.prQueues.value,
        });
        return getObjectTypedValues(PrQueueKind)
            .filter((kind) => {
                /** Only a list known to be empty is hidden, not one still loading or failing. */
                const shown = queues[kind];
                return (
                    !shown.queue?.updatedAt ||
                    !!shown.queue.pullRequests.length ||
                    !!shown.queue.error ||
                    !!shown.loadError
                );
            })
            .map((kind) => {
                return html`
                    <${VirReviewQueueSidebar.assign({
                        context,
                        route,
                        activePullRequest: undefined,
                        prQueues: state.prQueues,
                        queue: state.queue,
                        retry: state.retry,
                        fixedQueue: kind,
                    })}></${VirReviewQueueSidebar}>
                `;
            });
    },
});
