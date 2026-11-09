import {
    type ActivityRoute,
    type AppContext,
    defineAppElement,
    ScreenSize,
} from '@agent-storm/core/frontend';
import {css, html, listen, type Observable} from 'element-vir';
import {
    getShownPrQueues,
    type PrQueueKind,
    type PrQueuesObservable,
    pullRequestRouteKey,
} from '../../util/pr-queues.js';
import {reviewMemory} from '../../util/review-memory.js';
import {subPathsForPullRequest} from '../../util/review-route.js';
import {findReviewState} from '../../util/review-state.js';
import {VirReviewSidebar} from './vir-review-sidebar.element.js';

/** The review lists, wired to the app: picking a pull request routes to it. */
export const VirReviewQueueSidebar = defineAppElement<{
    context: AppContext;
    route: ActivityRoute;
    prQueues: PrQueuesObservable;
    /** Keyed by `pullRequestRouteKey`. */
    activePullRequest: string | undefined;
    /**
     * The Review tab's list. Undefined until picked this session, so the stored pick can load
     * later.
     */
    queue: Observable<PrQueueKind | undefined>;
    /** Set to a new object each time the user selects a PR, to retry its review folder. */
    retry: Observable<Readonly<{key: string}> | undefined>;
    /** Shows only this list. Picking one of its pull requests also makes it the Review tab's list. */
    fixedQueue?: PrQueueKind | undefined;
}>()({
    tagName: 'vir-review-queue-sidebar',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            min-width: 0;
            min-height: 0;
        }

        ${VirReviewSidebar} {
            flex-grow: 1;
            min-height: 0;
        }
    `,
    render({inputs}) {
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        function selectQueue(queue: PrQueueKind) {
            inputs.queue.setValue(queue);
            reviewMemory.selectedQueue.write(queue);
        }

        return html`
            <${VirReviewSidebar.assign({
                activePullRequest: inputs.activePullRequest,
                queues: getShownPrQueues({
                    prQueues: inputs.prQueues.value,
                    prReviews: findReviewState(inputs.context).prReviews.value,
                }),
                selectedQueue: inputs.queue.value || reviewMemory.selectedQueue.read(),
                fixedQueue: inputs.fixedQueue,
                hideBorder: isMobile,
                mobileModal: isMobile,
            })}
                ${listen(VirReviewSidebar.events.paneRestarted, async (event) => {
                    await inputs.context.paneRestarts.restart(event.detail);
                })}
                ${listen(VirReviewSidebar.events.settingsRequested, (event) => {
                    inputs.context.openSettings(event.detail);
                })}
                ${listen(VirReviewSidebar.events.queueSelected, (event) => {
                    selectQueue(event.detail);
                })}
                ${listen(VirReviewSidebar.events.refreshRequested, async (event) => {
                    await inputs.prQueues.forceRefresh(event.detail);
                })}
                ${listen(VirReviewSidebar.events.pullRequestActivated, (event) => {
                    inputs.route.navigate(subPathsForPullRequest(event.detail));
                    inputs.retry.setValue({
                        key: pullRequestRouteKey(event.detail),
                    });
                    if (inputs.fixedQueue) {
                        selectQueue(inputs.fixedQueue);
                    }
                })}
            ></${VirReviewSidebar}>
        `;
    },
});
