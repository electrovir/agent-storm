import {createSettingsTarget, defineSettingsSection} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {buildV2PluginId} from '../../build-v2-api.js';
import {VirAiChatModelDefaults} from './vir-ai-chat-model-defaults.element.js';

const searchTerms = [
    'model',
    'effort',
    'default',
];

/** The model and effort every new AI chat starts with, unless its folder has its own. */
export const aiChatSettingsSection = defineSettingsSection({
    pluginId: buildV2PluginId,
    name: 'ai-chat',
    label: 'AI Chat',
    searchTerms,
    schemaCardTitle: undefined,
    schemaKeys: [],
    render({context, settings, changeSettings}) {
        return html`
            <${VirAiChatModelDefaults.assign({
                context,
                settings,
                folderPicker: undefined,
            })}
                ${listen(VirAiChatModelDefaults.events.settingsChange, (event) => {
                    changeSettings(event.detail);
                })}
            ></${VirAiChatModelDefaults}>
        `;
    },
});

/** Each folder's own model and effort for new AI chats. */
export const folderSettingsSection = defineSettingsSection<
    Readonly<{
        folder: string;
    }>
>({
    pluginId: buildV2PluginId,
    name: 'folders',
    label: 'Folders',
    searchTerms: [
        ...searchTerms,
        'folder',
    ],
    schemaCardTitle: undefined,
    schemaKeys: [],
    render({context, settings, details, changeSettings}) {
        return html`
            <${VirAiChatModelDefaults.assign({
                context,
                settings,
                folderPicker: {
                    folder: details?.folder,
                },
            })}
                ${listen(VirAiChatModelDefaults.events.settingsChange, (event) => {
                    changeSettings(event.detail);
                })}
                ${listen(VirAiChatModelDefaults.events.folderSelect, (event) => {
                    context.openSettings(
                        createSettingsTarget({
                            section: folderSettingsSection,
                            details: {
                                folder: event.detail,
                            },
                        }),
                    );
                })}
            ></${VirAiChatModelDefaults}>
        `;
    },
});
