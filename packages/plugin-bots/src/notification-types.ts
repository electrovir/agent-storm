import {defineNotificationType, type NotificationType} from '@agent-storm/common';
import {botsPluginId} from './bots-api.js';

/** What the Bots plugin can notify the user of. */
export enum BotsNotificationName {
    Question = 'question',
    Message = 'message',
    RunFailed = 'runFailed',
}

export const botsNotificationTypes: Readonly<Record<BotsNotificationName, NotificationType>> = {
    [BotsNotificationName.Question]: defineNotificationType({
        name: BotsNotificationName.Question,
        pluginId: botsPluginId,
        label: 'Bot question',
        description: 'A bot asks a question and waits for your answer.',
    }),
    [BotsNotificationName.Message]: defineNotificationType({
        name: BotsNotificationName.Message,
        pluginId: botsPluginId,
        label: 'Bot message',
        description: 'A bot sends a notification of its own.',
    }),
    [BotsNotificationName.RunFailed]: defineNotificationType({
        name: BotsNotificationName.RunFailed,
        pluginId: botsPluginId,
        label: 'Bot run failed',
        description: 'A bot run fails or stops reporting back.',
    }),
};
