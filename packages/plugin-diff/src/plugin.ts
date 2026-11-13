import {diffPaneId} from '@agent-storm/common';
import {definePlugin} from '@agent-storm/core/frontend';
import {diffPane} from './ui/elements/diff-pane.js';
import {diffSettingsSection} from './ui/elements/diff-settings-section.js';

export const diffPlugin = definePlugin({
    id: diffPaneId,
    name: 'Diff',
    description: "Diff tabs showing a folder's changes.",
    panes: [
        diffPane,
    ],
    settingsSections: [
        diffSettingsSection,
    ],
});
