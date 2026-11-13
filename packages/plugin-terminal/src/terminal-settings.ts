import {definePluginSettings, PluginSettingKind} from '@agent-storm/core/frontend';

export const terminalSettings = definePluginSettings({
    clickableLinks: {
        kind: PluginSettingKind.Boolean,
        label: 'Clickable terminal links',
        description:
            "When on, URLs that appear in terminal output are auto-detected and clicking them opens the link in a new browser tab. Turn off if accidental link clicks (e.g. from terminal selections or stray taps) are opening pages you didn't intend.",
        default: true,
    },
});
