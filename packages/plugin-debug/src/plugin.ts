import {definePlugin} from '@agent-storm/core/frontend';
import {debugActivity} from './ui/elements/debug-activity.js';

export const debugPlugin = definePlugin({
    id: 'debug',
    name: 'Debug',
    description: "The app's own diagnostics.",
    activities: [
        debugActivity,
    ],
});
