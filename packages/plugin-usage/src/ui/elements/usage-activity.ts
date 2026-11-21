import {defineActivity} from '@agent-storm/core/frontend';
import {html} from 'element-vir';
import {usagePluginId} from '../../usage-api.js';
import {VirUsageView} from './vir-usage-view.element.js';

/** Plan limits and AI spending across the app's plugins. */
export const usageActivity = defineActivity({
    id: usagePluginId,
    label: 'Usage',
    isEnabledByDefault: true,
    mobileMenuTitle: 'Usage',
    sidebar: undefined,
    isKeptMounted: false,
    render() {
        return html`
            <${VirUsageView}></${VirUsageView}>
        `;
    },
});
