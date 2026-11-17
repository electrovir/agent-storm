import {definePlugin} from '@agent-storm/core/frontend';
import {buildV2PluginId} from './build-v2-api.js';
import {aiChatPane} from './ui/elements/ai-chat-pane.js';
import {buildV2Activity} from './ui/elements/build-v2-activity.js';
import {
    aiChatSettingsSection,
    folderSettingsSection,
} from './ui/elements/build-v2-settings-sections.js';

export const buildV2Plugin = definePlugin({
    id: buildV2PluginId,
    name: 'Build V2',
    description:
        'Chat threads with Claude and Codex, grouped by repo, with every write gated by approval.',
    activities: [
        buildV2Activity,
    ],
    panes: [
        aiChatPane,
    ],
    settingsSections: [
        aiChatSettingsSection,
        folderSettingsSection,
    ],
});
