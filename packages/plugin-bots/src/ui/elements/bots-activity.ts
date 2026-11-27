import {defineActivity} from '@agent-storm/core/frontend';
import {html} from 'element-vir';
import {botsPluginId} from '../../bots-api.js';
import {botsMemory} from '../../util/bots-memory.js';
import {createBotsState, startBotsState} from '../../util/bots-state.js';
import {VirBotsSidebar} from './vir-bots-sidebar.element.js';
import {VirBotsStage} from './vir-bots-stage.element.js';

/** The bots each repo lists in its `agent-storm.config` file. */
export const botsActivity = defineActivity({
    id: botsPluginId,
    label: 'Bots',
    isEnabledByDefault: true,
    createState: createBotsState,
    mobileMenuTitle: 'Bots',
    sidebar: {
        widthSetting: botsMemory.sidebarWidth,
        render({state, route}) {
            return html`
                <${VirBotsSidebar.assign({
                    snapshot: state.snapshot.value,
                    route,
                })}></${VirBotsSidebar}>
            `;
        },
    },
    isKeptMounted: true,
    render({context, state, route, isShown}) {
        return html`
            <${VirBotsStage.assign({
                context,
                snapshot: state.snapshot.value,
                subPaths: route.subPaths,
                isShown,
            })}></${VirBotsStage}>
        `;
    },
    /** The questions waiting on the user. */
    findCount({state}) {
        return state.snapshot.value.state?.questions.length || undefined;
    },
    startWithApp({state, services}) {
        return startBotsState({
            state,
            services,
        });
    },
});
