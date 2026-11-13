import {defineSettingsSection} from '@agent-storm/core/frontend';

/** How the Build sidebar groups, sorts, and filters its folders. */
export const sidebarSettingsSection = defineSettingsSection({
    pluginId: 'build',
    name: 'sidebar',
    label: 'Sidebar',
    searchTerms: [],
    schemaCardTitle: undefined,
    schemaKeys: [
        'sidebarGrouping',
        'sidebarSorting',
        'onlyShowRecent',
    ],
});
