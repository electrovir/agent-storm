import {defineNotificationType, type NotificationType} from '@agent-storm/common';
import {buildPluginId} from './build-api.js';

/** What Build can notify the user of. */
export enum BuildNotificationName {
    NeedsAttention = 'needsAttention',
    ThreadFinished = 'threadFinished',
    PriorityThreadFinished = 'priorityThreadFinished',
    WorktreeNeedsReview = 'worktreeNeedsReview',
}

export const buildNotificationTypes: Readonly<Record<BuildNotificationName, NotificationType>> = {
    [BuildNotificationName.NeedsAttention]: defineNotificationType({
        name: BuildNotificationName.NeedsAttention,
        pluginId: buildPluginId,
        label: 'Thread needs your attention',
        description: 'A thread asks a question, waits on an approval, or fails.',
    }),
    [BuildNotificationName.ThreadFinished]: defineNotificationType({
        name: BuildNotificationName.ThreadFinished,
        pluginId: buildPluginId,
        label: 'Thread finished',
        description: "A thread that isn't a priority finishes its work.",
        isOptIn: true,
    }),
    [BuildNotificationName.PriorityThreadFinished]: defineNotificationType({
        name: BuildNotificationName.PriorityThreadFinished,
        pluginId: buildPluginId,
        label: 'Priority thread finished',
        description: 'A thread flagged as a priority finishes its work.',
    }),
    [BuildNotificationName.WorktreeNeedsReview]: defineNotificationType({
        name: BuildNotificationName.WorktreeNeedsReview,
        pluginId: buildPluginId,
        label: 'Worktree needs your review',
        description:
            "A folder's PR has its manual review set up and none of its threads still work.",
    }),
};
