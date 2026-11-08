import {getObjectTypedValues} from '@augment-vir/common';
import {css, html, nothing} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {PrQueueKind, getShownPrQueues} from '../../util/frontend-state.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';
import {VirReviewQueueSidebar} from './vir-review-queue-sidebar.element.js';

/** The Dashboard tab: the Build list and each review list side by side, or stacked on mobile. */
export const VirDashboard = defineAppElement<{
    context: AppContext;
    /** Heads the folder list, naming the activity it opens. */
    buildListHeading: string;
}>()({
    tagName: 'vir-dashboard',
    hostClasses: {
        'vir-dashboard-mobile'({inputs}) {
            return inputs.context.screenSize === ScreenSize.Mobile;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                flex-grow: 1;
                min-width: 0;
                min-height: 0;
            }

            ${VirBuildSidebar}, ${VirReviewQueueSidebar} {
                width: 0;
                flex-grow: 1;
                min-width: 0;
            }

            /* Stacks the lists on mobile. */
            ${hostClasses['vir-dashboard-mobile'].selector} {
                flex-direction: column;

                & ${VirBuildSidebar}, & ${VirReviewQueueSidebar} {
                    width: 100%;
                    height: 0;
                    min-height: 0;
                }
            }
        `;
    },
    render({inputs}) {
        const frontendState = inputs.context.frontendState?.value;
        const queues = frontendState && getShownPrQueues(frontendState);

        return html`
            ${inputs.context.folderData.value.folderInfo.size
                ? html`
                      <${VirBuildSidebar.assign({
                          context: inputs.context,
                          heading: inputs.buildListHeading,
                      })}></${VirBuildSidebar}>
                  `
                : nothing}
            ${getObjectTypedValues(PrQueueKind)
                .filter((kind) => {
                    /** Only a list known to be empty is hidden, not one still loading or failing. */
                    const shown = queues?.[kind];
                    return (
                        !shown?.queue?.updatedAt ||
                        !!shown.queue.pullRequests.length ||
                        !!shown.queue.error ||
                        !!shown.loadError
                    );
                })
                .map((kind) => {
                    return html`
                        <${VirReviewQueueSidebar.assign({
                            context: inputs.context,
                            fixedQueue: kind,
                        })}></${VirReviewQueueSidebar}>
                    `;
                })}
        `;
    },
});
