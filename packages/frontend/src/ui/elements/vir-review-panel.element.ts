import {css, html, nothing} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {MainTab} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirReviewQueueSidebar} from './vir-review-queue-sidebar.element.js';
import {VirReviewStage} from './vir-review-stage.element.js';
import {VirSidebarLayout} from './vir-sidebar-layout.element.js';

/** The Review tab: the review lists beside the selected pull request's panes. */
export const VirReviewPanel = defineAppElement<{
    context: AppContext;
}>()({
    tagName: 'vir-review-panel',
    hostClasses: {
        'vir-review-panel-hidden'({inputs}) {
            return inputs.context.resolved.mainTab !== MainTab.Review;
        },
    },
    state() {
        return {
            /**
             * Set when the Review tab is first opened, and never reset, so each selected PR's panes
             * stay alive while another tab shows.
             */
            hasOpened: false,
        };
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                flex-grow: 1;
                min-width: 0;
                min-height: 0;
            }

            /*
             * Hidden rather than unmounted: every mounted pane group holds live /pty WebSocket(s)
             * and xterm scrollback, and the review list would re-fetch, so unmounting on every tab
             * switch would tear all of that down.
             */
            ${hostClasses['vir-review-panel-hidden'].selector} {
                display: none;
            }

            ${VirSidebarLayout} {
                flex-grow: 1;
            }
        `;
    },
    render({inputs, state, updateState}) {
        const isShown = inputs.context.resolved.mainTab === MainTab.Review;
        if (isShown && !state.hasOpened) {
            updateState({
                hasOpened: true,
            });
        }
        if (!isShown && !state.hasOpened) {
            return '';
        }
        const isMobile = inputs.context.screenSize === ScreenSize.Mobile;

        return html`
            <${VirSidebarLayout.assign({
                widthSetting: localStorageClient.reviewSidebarWidth,
                isMobile,
            })}>
                ${isMobile
                    ? nothing
                    : html`
                          <${VirReviewQueueSidebar.assign({
                              context: inputs.context,
                          })}
                              slot=${VirSidebarLayout.slotNames['vir-sidebar-layout-sidebar']}
                          ></${VirReviewQueueSidebar}>
                      `}
                <${VirReviewStage.assign({
                    context: inputs.context,
                    activePullRequest: inputs.context.resolved.activePullRequest,
                    reviewQueueKeys: inputs.context.resolved.reviewQueueKeys,
                    isShown,
                    retryRequest: inputs.context.reviewRetry.value,
                })}></${VirReviewStage}>
            </${VirSidebarLayout}>
        `;
    },
});
