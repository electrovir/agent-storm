import {definePlugin} from '@agent-storm/core/frontend';
import {usageActivity} from './ui/elements/usage-activity.js';
import {usagePluginId} from './usage-api.js';

export const usagePlugin = definePlugin({
    id: usagePluginId,
    name: 'Usage',
    description:
        "Claude and Codex plan limits, and the tokens and cost each plugin's AI runs spend.",
    activities: [
        usageActivity,
    ],
});
