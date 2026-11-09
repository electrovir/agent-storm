import {
    type ActivityRoute,
    type AnyActivityDefinition,
    type AppContext,
    ScreenSize,
    defineAppElement,
} from '@agent-storm/core/frontend';
import {css, html, nothing} from 'element-vir';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirSidebarLayout} from './vir-sidebar-layout.element.js';

/** One activity's area: its sidebar beside its content, or its content alone. */
export const VirActivityPanel = defineAppElement<{
    context: AppContext;
    activity: AnyActivityDefinition;
    route: ActivityRoute;
    /** Whether the route selects this activity. */
    isShown: boolean;
}>()({
    tagName: 'vir-activity-panel',
    hostClasses: {
        'vir-activity-panel-hidden'({inputs}) {
            return !inputs.isShown;
        },
    },
    state() {
        return {
            /** Set when the activity first shows, and never reset. */
            hasShown: false,
        };
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                flex-direction: column;
                flex-grow: 1;
                min-width: 0;
                min-height: 0;
            }

            /*
             * Hidden rather than unmounted: every mounted pane group holds live /pty WebSocket(s)
             * and xterm scrollback, so unmounting on every activity switch would tear all of that
             * down.
             */
            ${hostClasses['vir-activity-panel-hidden'].selector} {
                display: none;
            }

            ${VirSidebarLayout} {
                flex-grow: 1;
            }

            .sidebar {
                display: flex;
                flex-direction: column;

                & > * {
                    flex-grow: 1;
                    min-height: 0;
                }
            }
        `;
    },
    render({inputs, state, updateState}) {
        const definition = inputs.activity;
        const isShown = inputs.isShown;
        const params = {
            context: inputs.context,
            state: inputs.context.activityStates[definition.id],
            route: inputs.route,
        };
        if (isShown && !state.hasShown) {
            updateState({
                hasShown: true,
            });
        }
        if (!isShown && !(definition.isKeptMounted && state.hasShown)) {
            return '';
        }
        /** An Activity tab has no room for the mobile menu, so it lays out as on desktop. */
        const isMobile =
            inputs.context.screenSize === ScreenSize.Mobile && !inputs.context.isInActivityTab;
        const content = definition.render({
            ...params,
            isShown,
        });

        return html`
            ${isMobile && definition.mobileMenuTitle == undefined
                ? html`
                      <${VirMainTabs.assign({
                          context: inputs.context,
                          activityId: definition.id,
                          isHorizontal: true,
                      })}></${VirMainTabs}>
                  `
                : nothing}
            ${definition.sidebar
                ? html`
                      <${VirSidebarLayout.assign({
                          widthSetting: definition.sidebar.widthSetting,
                          isMobile,
                      })}>
                          ${isMobile
                              ? nothing
                              : html`
                                    <div
                                        class="sidebar"
                                        slot=${VirSidebarLayout.slotNames[
                                            'vir-sidebar-layout-sidebar'
                                        ]}
                                    >
                                        ${definition.sidebar.render(params)}
                                    </div>
                                `}
                          ${content}
                      </${VirSidebarLayout}>
                  `
                : content}
        `;
    },
});
