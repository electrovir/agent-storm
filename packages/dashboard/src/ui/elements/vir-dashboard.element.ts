import {type AppContext, ScreenSize, defineAppElement} from '@agent-storm/core/frontend';
import {css, html} from 'element-vir';

/** The Dashboard tab: each activity's lists side by side, or stacked on mobile. */
export const VirDashboard = defineAppElement<{
    context: AppContext;
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

            .column {
                display: flex;
                flex-direction: column;
                width: 0;
                flex-grow: 1;
                min-width: 0;

                & > * {
                    flex-grow: 1;
                    min-height: 0;
                }
            }

            /* Stacks the lists on mobile. */
            ${hostClasses['vir-dashboard-mobile'].selector} {
                flex-direction: column;

                & .column {
                    width: 100%;
                    height: 0;
                    min-height: 0;
                }
            }
        `;
    },
    render({inputs}) {
        const context = inputs.context;
        return context.activities.flatMap((activity) => {
            return (
                activity
                    .renderInDashboard?.({
                        context,
                        state: context.activityStates[activity.id],
                        route: {
                            subPaths: [],
                            navigate(subPaths) {
                                context.navigate([
                                    activity.id,
                                    ...subPaths,
                                ]);
                            },
                        },
                    })
                    .map((column) => {
                        return html`
                            <div class="column">${column}</div>
                        `;
                    }) || []
            );
        });
    },
});
