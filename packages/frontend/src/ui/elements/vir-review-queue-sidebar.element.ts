import {css, html, listen} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {routeForPullRequest} from '../../util/app-route.js';
import {
    getShownPrQueues,
    type PrQueueKind,
    pullRequestRouteKey,
} from '../../util/frontend-state.js';
import {router} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirReviewSidebar} from './vir-review-sidebar.element.js';

/** The review lists, wired to the app: picking a pull request routes to it. */
export const VirReviewQueueSidebar = defineAppElement<{
    context: AppContext;
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
        const frontendState = inputs.context.frontendState;
        const localDbClient = frontendState?.value.localDbClient;
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        async function selectQueue(queue: PrQueueKind) {
            inputs.context.reviewQueue.setValue(queue);
            await localDbClient?.set.review({
                ...localDbClient.value.review,
                selectedQueue: queue,
            });
        }

        return html`
            <${VirReviewSidebar.assign({
                activePullRequest: inputs.context.resolved.activePullRequest,
                queues: frontendState && getShownPrQueues(frontendState.value),
                selectedQueue:
                    inputs.context.reviewQueue.value ||
                    localDbClient?.value.review?.selectedQueue ||
                    undefined,
                fixedQueue: inputs.fixedQueue,
                hideBorder: isMobile,
                mobileModal: isMobile,
            })}
                ${listen(VirReviewSidebar.events.paneRestarted, async (event) => {
                    await inputs.context.paneRestarts.restart(event.detail);
                })}
                ${listen(VirReviewSidebar.events.queueSelected, (event) => {
                    return selectQueue(event.detail);
                })}
                ${listen(VirReviewSidebar.events.refreshRequested, async (event) => {
                    await frontendState?.forceRefreshPrQueue(event.detail);
                })}
                ${listen(VirReviewSidebar.events.pullRequestActivated, async (event) => {
                    router.setRoute(routeForPullRequest(event.detail));
                    inputs.context.reviewRetry.setValue({
                        key: pullRequestRouteKey(event.detail),
                    });
                    if (inputs.fixedQueue) {
                        await selectQueue(inputs.fixedQueue);
                    }
                })}
            ></${VirReviewSidebar}>
        `;
    },
});
