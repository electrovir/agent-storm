import {terminalPluginId} from '@agent-storm/common';
import {definePlugin} from '@agent-storm/core/frontend';
import {terminalSettings} from './terminal-settings.js';
import {aiPane, shellPane} from './ui/elements/terminal-panes.js';

export const terminalPlugin = definePlugin({
    id: terminalPluginId,
    name: 'Terminals',
    description: 'AI and shell tabs.',
    settings: terminalSettings,
    panes: [
        aiPane,
        shellPane,
    ],
});
