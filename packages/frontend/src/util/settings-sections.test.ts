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

const hostedSection = defineSettingsSection({
    ...pluginSection,
    name: 'hosted',
    coreSection: SettingsSection.Ai,
});

const sections = listSettingsSections([
    pluginSection,
    hostedSection,
]);

describe(listSettingsSections.name, () => {
    it('lists plugin sections right after the Plugins section or the core page they show in', () => {
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
                'example:hosted',
                SettingsSection.Folders,
                SettingsSection.Notifications,
                SettingsSection.Forges,
                SettingsSection.Maintenance,
            ],
        );
    });
});

describe(groupPluginSettingsSections.name, () => {
    it('groups sections by plugin, skipping plugins without any and sections shown in core pages', () => {
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
                    hostedSection,
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
    it('finds the core page a hosted plugin section shows in', () => {
        assert.strictEquals(
            findSettingsSection({
                sections,
                id: 'example:hosted',
            })?.id,
            SettingsSection.Ai,
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
