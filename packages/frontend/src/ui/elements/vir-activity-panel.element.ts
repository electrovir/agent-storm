import {css, html, nothing} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {type ActivityId} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {activityDefinitions} from './activity-definitions.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirSidebarLayout} from './vir-sidebar-layout.element.js';

/** One activity's area: its sidebar beside its content, or its content alone. */
export const VirActivityPanel = defineAppElement<{
    context: AppContext;
    activityId: ActivityId;
}>()({
    tagName: 'vir-activity-panel',
    hostClasses: {
        'vir-activity-panel-hidden'({inputs}) {
            return inputs.context.resolved.activityId !== inputs.activityId;
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
        const definition = activityDefinitions[inputs.activityId];
        const isShown = inputs.context.resolved.activityId === inputs.activityId;
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
            context: inputs.context,
            isShown,
        });

        return html`
            ${isMobile && definition.mobileMenuTitle == undefined
                ? html`
                      <${VirMainTabs.assign({
                          context: inputs.context,
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
                                        ${definition.sidebar.render(inputs.context)}
                                    </div>
                                `}
                          ${content}
                      </${VirSidebarLayout}>
                  `
                : content}
        `;
    },
});
