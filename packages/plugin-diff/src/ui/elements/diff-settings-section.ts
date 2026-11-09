import {diffPaneId} from '@agent-storm/common';
import {defineSettingsSection, SettingsSection} from '@agent-storm/core/frontend';

/** The diff pane's display settings, which render as plain rows. */
export const diffSettingsSection = defineSettingsSection({
    pluginId: diffPaneId,
    name: 'settings',
    label: 'Diff',
    group: 'App',
    searchTerms: [],
    schemaCardTitle: undefined,
    schemaKeys: [
        'diffLayout',
        'diffHideWhitespace',
        'diffCollapseUnchanged',
    ],
    listAfter: SettingsSection.Sidebar,
});
