import {definePlugin} from '@agent-storm/core/frontend';
import {getObjectTypedValues} from '@augment-vir/common';
import {botsPluginId} from './bots-api.js';
import {botsNotificationTypes} from './notification-types.js';
import {botPane} from './ui/elements/bot-pane.js';
import {botsActivity} from './ui/elements/bots-activity.js';

export const botsPlugin = definePlugin({
    id: botsPluginId,
    name: 'Bots',
    description:
        'Runs the bots each repo lists in its .agent-storm/agent-storm.config file, on a schedule, with their shells, AI chats, questions, and run history.',
    activities: [
        botsActivity,
    ],
    panes: [
        botPane,
    ],
    notificationTypes: getObjectTypedValues(botsNotificationTypes),
});
