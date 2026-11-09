import {defineActivity} from '@agent-storm/core/frontend';
import {html} from 'element-vir';
import {VirDashboard} from './vir-dashboard.element.js';

/** Every other activity's lists side by side, each opening its own activity. */
export const dashboardActivity = defineActivity({
    id: 'dashboard',
    label: 'Dashboard',
    isEnabledByDefault: true,
    mobileMenuTitle: undefined,
    sidebar: undefined,
    isKeptMounted: false,
    render({context}) {
        return html`
            <${VirDashboard.assign({
                context,
            })}></${VirDashboard}>
        `;
    },
});
