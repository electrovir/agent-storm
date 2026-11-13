import {getObjectTypedValues} from '@augment-vir/common';
import {html, listen} from 'element-vir';
import {VirPluginSettingsForm} from '../ui/elements/vir-plugin-settings-form.element.js';
import {
    defineSettingsSection,
    type PluginDefinition,
    type SettingsSectionContribution,
} from './plugin-api.js';
import {
    isPluginSettingsModified,
    resolvePluginSettings,
    restorePluginSettings,
    writePluginSetting,
} from './plugin-settings.js';

/** The Settings modal page for a plugin's `settings`. */
export function createPluginSettingsSection(
    plugin: Readonly<PluginDefinition>,
): SettingsSectionContribution {
    const definition = plugin.settings;
    return defineSettingsSection({
        pluginId: plugin.id,
        name: 'settings',
        label: plugin.name,
        searchTerms: getObjectTypedValues(definition?.fields || {}).flatMap((field) => {
            return [
                field.label,
                field.description,
            ];
        }),
        schemaCardTitle: undefined,
        schemaKeys: [],
        defaults: {
            isModified(settings) {
                return isPluginSettingsModified({
                    plugin,
                    settings,
                });
            },
            restore(settings) {
                return restorePluginSettings({
                    plugin,
                    settings,
                });
            },
        },
        render({settings, changeSettings}) {
            return html`
                <${VirPluginSettingsForm.assign({
                    definition: definition || {
                        fields: {},
                    },
                    values: resolvePluginSettings({
                        plugin,
                        settings,
                    }),
                })}
                    ${listen(VirPluginSettingsForm.events.valueChange, (event) => {
                        changeSettings((current) => {
                            return writePluginSetting({
                                plugin,
                                settings: current,
                                key: event.detail.key,
                                value: event.detail.value,
                            });
                        });
                    })}
                ></${VirPluginSettingsForm}>
            `;
        },
    });
}
