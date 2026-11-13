import {definePlugin} from '@agent-storm/core/frontend';
import {dashboardActivity} from './ui/elements/dashboard-activity.js';

export const dashboardPlugin = definePlugin({
    id: 'dashboard',
    name: 'Dashboard',
    description: "Every other activity's columns on one page.",
    activities: [
        dashboardActivity,
    ],
});
