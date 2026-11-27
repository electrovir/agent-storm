import {terminalPluginId} from '@agent-storm/common';
import {definePlugin} from '@agent-storm/core/frontend';
import {terminalSettings} from './terminal-settings.js';
import {shellPane} from './ui/elements/terminal-panes.js';

export const terminalPlugin = definePlugin({
    id: terminalPluginId,
    name: 'Terminals',
    description: 'Shell tabs.',
    settings: terminalSettings,
    panes: [
        shellPane,
    ],
});
