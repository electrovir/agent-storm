import {noTabStateShape, PaneMounting, type PaneDefinition} from '@agent-storm/core/frontend';
import {html} from 'element-vir';
import {createSizedIcon, LucideBotIcon} from 'vira';
import {botPaneId, isBotsScope} from '../../bots-api.js';
import {findBotsState} from '../../util/bots-state.js';
import {VirBotsPane} from './vir-bots-pane.element.js';

/**
 * A bots pane group's Bot tab. Always mounted, since the bot's view is what gives the pane group
 * its shell tab.
 */
export const botPane: PaneDefinition = {
    id: botPaneId,
    tabStateShape: noTabStateShape,
    label() {
        return 'Bot';
    },
    newTabEntries() {
        return [
            {
                label: 'Bot',
                state: undefined,
            },
        ];
    },
    icon: createSizedIcon(LucideBotIcon, 14),
    mounting: PaneMounting.Always,
    isAvailable({scope}) {
        return isBotsScope(scope);
    },
    render({context, scope}) {
        return html`
            <${VirBotsPane.assign({
                context,
                scope,
                snapshot: findBotsState(context).snapshot,
            })}></${VirBotsPane}>
        `;
    },
};
