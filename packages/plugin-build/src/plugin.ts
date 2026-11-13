import {definePlugin} from '@agent-storm/core/frontend';
import {buildActivity} from './ui/elements/build-activity.js';
import {sidebarSettingsSection} from './ui/elements/sidebar-settings-section.js';

export const buildPlugin = definePlugin({
    id: 'build',
    name: 'Build',
    description: 'Folders and their AI and terminal tabs.',
    activities: [
        buildActivity,
    ],
    settingsSections: [
        sidebarSettingsSection,
    ],
});
