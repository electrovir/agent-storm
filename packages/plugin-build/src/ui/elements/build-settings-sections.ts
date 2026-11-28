import {
    createSettingsTarget,
    defineSettingsSection,
    SettingsSection,
} from '@agent-storm/core/frontend';
import {getObjectTypedKeys} from '@augment-vir/common';
import {html, listen} from 'element-vir';
import {buildPluginId} from '../../build-api.js';
import {
    pluginThreadModelLabels,
    VirAiChatModelDefaults,
} from './vir-ai-chat-model-defaults.element.js';

const searchTerms = [
    'model',
    'effort',
    'default',
];

/** The model and effort every new AI chat starts with, unless its folder has its own. */
export const aiChatSettingsSection = defineSettingsSection({
    pluginId: buildPluginId,
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
                origin: undefined,
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
    pluginId: buildPluginId,
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
                origin: undefined,
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

/** The models manual reviews and watch mode run on, which override the AI chat defaults. */
export const reviewModelSettingsSection = defineSettingsSection({
    pluginId: buildPluginId,
    name: 'review-models',
    label: 'Background models',
    coreSection: SettingsSection.Ai,
    searchTerms: [
        ...searchTerms,
        'review',
        'manual review',
        'watch mode',
    ],
    schemaCardTitle: undefined,
    schemaKeys: [],
    render({context, settings, changeSettings}) {
        return getObjectTypedKeys(pluginThreadModelLabels).map((origin) => {
            return html`
                <${VirAiChatModelDefaults.assign({
                    context,
                    settings,
                    folderPicker: undefined,
                    origin,
                })}
                    ${listen(VirAiChatModelDefaults.events.settingsChange, (event) => {
                        changeSettings(event.detail);
                    })}
                ></${VirAiChatModelDefaults}>
            `;
        });
    },
});
