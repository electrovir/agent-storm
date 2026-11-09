import {SettingsSection, defineSettingsSection} from '@agent-storm/core/frontend';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {findSettingsSection, listSettingsSections} from './settings-sections.js';

const pluginSection = defineSettingsSection({
    pluginId: 'example',
    name: 'settings',
    label: 'Example',
    group: 'App',
    searchTerms: [],
    schemaCardTitle: undefined,
    schemaKeys: [],
    listAfter: SettingsSection.Sidebar,
});

const sections = listSettingsSections([
    pluginSection,
]);

describe(listSettingsSections.name, () => {
    it('lists a plugin section right after the core section it names', () => {
        assert.deepEquals(
            sections.map((section) => section.id),
            [
                SettingsSection.General,
                SettingsSection.Terminal,
                SettingsSection.Sidebar,
                'example:settings',
                SettingsSection.Activities,
                SettingsSection.Ai,
                SettingsSection.Folders,
                SettingsSection.Forges,
                SettingsSection.Maintenance,
            ],
        );
    });
});

describe(findSettingsSection.name, () => {
    it('finds a plugin section by its id', () => {
        assert.strictEquals(
            findSettingsSection({
                sections,
                id: 'example:settings',
            })?.id,
            'example:settings',
        );
    });
    it('falls back to General for an id with no section, like the old diff and review ids', () => {
        assert.deepEquals(
            [
                'diff',
                'review',
                'gone:settings',
            ].map((id) => {
                return findSettingsSection({
                    sections,
                    id,
                })?.id;
            }),
            [
                SettingsSection.General,
                SettingsSection.General,
                SettingsSection.General,
            ],
        );
    });
});
