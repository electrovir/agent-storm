import {definePlugin} from '@agent-storm/core/frontend';
import {getObjectTypedValues} from '@augment-vir/common';
import {buildPluginId} from './build-api.js';
import {buildNotificationTypes} from './notification-types.js';
import {aiChatPane} from './ui/elements/ai-chat-pane.js';
import {buildActivity} from './ui/elements/build-activity.js';
import {
    aiChatSettingsSection,
    folderSettingsSection,
    reviewModelSettingsSection,
} from './ui/elements/build-settings-sections.js';
import {viewerPane} from './ui/elements/viewer-pane.js';
import {voiceActivity} from './ui/elements/voice-activity.js';
import {composerShortcutActions} from './util/composer-shortcuts.js';

export const buildPlugin = definePlugin({
    id: buildPluginId,
    name: 'Build',
    description:
        'Chat threads with Claude and Codex, grouped by repo, with every write gated by approval.',
    activities: [
        buildActivity,
        voiceActivity,
    ],
    panes: [
        aiChatPane,
        viewerPane,
    ],
    settingsSections: [
        aiChatSettingsSection,
        folderSettingsSection,
        reviewModelSettingsSection,
    ],
    shortcutActions: getObjectTypedValues(composerShortcutActions),
    notificationTypes: getObjectTypedValues(buildNotificationTypes),
});
