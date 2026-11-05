import {css, html} from 'element-vir';
import {type AppContext} from '../../util/app-context.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {MainTab} from '../../util/router.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';
import {VirBuildStage} from './vir-build-stage.element.js';
import {VirSidebarLayout} from './vir-sidebar-layout.element.js';

/** The Build tab: the folder list beside the selected folder's panes. */
export const VirBuildPanel = defineAppElement<{
    context: AppContext;
}>()({
    tagName: 'vir-build-panel',
    hostClasses: {
        'vir-build-panel-hidden'({inputs}) {
            return inputs.context.resolved.mainTab !== MainTab.Build;
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

            /*
             * Hidden rather than unmounted: every mounted pane group holds live /pty WebSocket(s)
             * and xterm scrollback, so unmounting on every tab switch would tear all of that down.
             */
            ${hostClasses['vir-build-panel-hidden'].selector} {
                display: none;
            }

            ${VirSidebarLayout} {
                flex-grow: 1;
            }
        `;
    },
    render({inputs}) {
        return html`
            <${VirSidebarLayout.assign({
                widthSetting: localStorageClient.sidebarWidth,
                isMobile: inputs.context.screenSize === ScreenSize.Mobile,
            })}>
                <${VirBuildSidebar.assign({
                    context: inputs.context,
                })}
                    slot=${VirSidebarLayout.slotNames['vir-sidebar-layout-sidebar']}
                ></${VirBuildSidebar}>
                <${VirBuildStage.assign({
                    activeFolder: inputs.context.resolved.activeFolder?.path,
                    context: inputs.context,
                })}></${VirBuildStage}>
            </${VirSidebarLayout}>
        `;
    },
});
