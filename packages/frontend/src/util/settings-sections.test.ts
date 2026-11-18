import {SettingsSection, defineSettingsSection} from '@agent-storm/core/frontend';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    findSettingsSection,
    groupPluginSettingsSections,
    listSettingsSections,
} from './settings-sections.js';

const pluginSection = defineSettingsSection({
    pluginId: 'example',
    name: 'settings',
    label: 'Example',
    searchTerms: [],
    schemaCardTitle: undefined,
    schemaKeys: [],
});

const sections = listSettingsSections([
    pluginSection,
]);

describe(listSettingsSections.name, () => {
    it('lists plugin sections right after the Plugins section', () => {
        assert.deepEquals(
            sections.map((section) => section.id),
            [
                SettingsSection.General,
                SettingsSection.Typography,
                SettingsSection.Terminal,
                SettingsSection.KeyboardShortcuts,
                SettingsSection.Activities,
                SettingsSection.Plugins,
                'example:settings',
                SettingsSection.Ai,
                SettingsSection.Folders,
                SettingsSection.Forges,
                SettingsSection.Maintenance,
            ],
        );
    });
});

describe(groupPluginSettingsSections.name, () => {
    it('groups sections by plugin and skips plugins without any', () => {
        const otherSection = defineSettingsSection({
            ...pluginSection,
            name: 'other',
        });
        assert.deepEquals(
            groupPluginSettingsSections({
                plugins: [
                    {
                        id: 'empty',
                        name: 'Empty',
                    },
                    {
                        id: 'example',
                        name: 'Example',
                    },
                ],
                sections: [
                    pluginSection,
                    otherSection,
                ],
            }).map((group) => {
                return [
                    group.plugin.id,
                    group.sections.map((section) => section.id),
                ];
            }),
            [
                [
                    'example',
                    [
                        'example:settings',
                        'example:other',
                    ],
                ],
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
