// cspell:words forgejo, gitea

import {
    SettingsSection,
    type AnySettingsSectionContribution,
    type PluginDefinition,
} from '@agent-storm/core/frontend';
import {getEnumValues} from '@augment-vir/common';

/** One of core's own pages of the Settings modal, each of which gets a nav tab. */
export type CoreSettingsSectionPage = Omit<AnySettingsSectionContribution, 'id' | 'pluginId'> &
    Readonly<{
        id: SettingsSection;
        pluginId: undefined;
        /** The heading the page's tab lists under. */
        group: string;
    }>;

/** A page of the Settings modal, whether core's own or a plugin's. */
export type SettingsSectionPage = CoreSettingsSectionPage | AnySettingsSectionContribution;

/**
 * Core's own sections. Their rows are built from the schema keys listed here, in order, and the
 * dedicated element each section renders is chosen by the modal.
 */
const coreSettingsSections: Readonly<
    Record<SettingsSection, Omit<CoreSettingsSectionPage, 'id' | 'pluginId' | 'render'>>
> = {
    [SettingsSection.General]: {
        label: 'General',
        group: 'App',
        searchTerms: [
            'scrollback',
            'https',
            'logs',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [
            'disableUpdateCheck',
            'tlsCertPath',
            'enableDebugLogs',
        ],
    },
    [SettingsSection.Typography]: {
        label: 'Typography',
        group: 'App',
        searchTerms: [
            'font',
            'family',
            'size',
            'monospace',
            'smoothing',
            'wrap',
            'code',
            'prompt',
            'interface',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [
            'diffSoftWrap',
        ],
    },
    [SettingsSection.Terminal]: {
        label: 'Terminal',
        group: 'App',
        searchTerms: [],
        schemaCardTitle: undefined,
        schemaKeys: [
            'useWebgl',
        ],
    },
    [SettingsSection.KeyboardShortcuts]: {
        label: 'Keyboard shortcuts',
        group: 'App',
        searchTerms: [
            'keyboard',
            'shortcut',
            'hotkey',
            'keybinding',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Activities]: {
        label: 'Activity tabs',
        group: 'App',
        searchTerms: [
            'activities',
            'plugin',
            'show',
            'hide',
            'vertical tab',
            'dashboard',
            'debug',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Plugins]: {
        label: 'Plugins',
        group: 'App',
        searchTerms: [
            'extension',
            'approve',
            'block',
            'trust',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Ai]: {
        label: 'AI',
        group: 'Agents',
        searchTerms: [
            'model',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Folders]: {
        label: 'Folders',
        schemaCardTitle: 'Defaults',
        group: 'Agents',
        searchTerms: [
            'repo',
            'worktree',
            'init command',
            'review skill',
            'override',
        ],
        schemaKeys: [
            'postWorktreeCmd',
            'reviewSkill',
        ],
    },
    [SettingsSection.Notifications]: {
        label: 'Notifications',
        group: 'Agents',
        searchTerms: [
            'notification',
            'push',
            'alert',
            'toast',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Forges]: {
        label: 'Git forges',
        group: 'Git',
        searchTerms: [
            'github',
            'gitea',
            'forgejo',
            'gitlab',
            'bot',
            'polling',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Maintenance]: {
        label: 'Maintenance',
        group: 'System',
        searchTerms: [
            'daemon',
            'pty',
            'restart',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
};

/** Core's own pages, in the order of their nav tabs. */
export const coreSettingsSectionPages: ReadonlyArray<CoreSettingsSectionPage> = getEnumValues(
    SettingsSection,
).map((section) => {
    return {
        ...coreSettingsSections[section],
        id: section,
        pluginId: undefined,
    };
});

/**
 * Every section in the order search lists them: core's in their own order, each followed by the
 * plugin sections it shows, with every other plugin section after the Plugins section, in the order
 * the plugins were registered.
 */
export function listSettingsSections(
    pluginSections: ReadonlyArray<AnySettingsSectionContribution>,
): ReadonlyArray<SettingsSectionPage> {
    return coreSettingsSectionPages.flatMap((page) => {
        return [
            page,
            ...pluginSections.filter((section) => {
                return page.id === SettingsSection.Plugins
                    ? !section.coreSection
                    : section.coreSection === page.id;
            }),
        ];
    });
}

/**
 * Each plugin that has a settings section in the Plugins section, with those sections, in the
 * plugins' order.
 */
export function groupPluginSettingsSections({
    plugins,
    sections,
}: Readonly<{
    plugins: ReadonlyArray<Pick<PluginDefinition, 'id' | 'name'>>;
    sections: ReadonlyArray<AnySettingsSectionContribution>;
}>) {
    return plugins
        .map((plugin) => {
            return {
                plugin,
                sections: sections.filter((section) => {
                    return section.pluginId === plugin.id && !section.coreSection;
                }),
            };
        })
        .filter((group) => group.sections.length);
}

/**
 * The section `id` names, or the core page it shows in, or the General section when none does, like
 * a plugin's section from before that plugin was turned off.
 */
export function findSettingsSection({
    sections,
    id,
}: Readonly<{
    sections: ReadonlyArray<SettingsSectionPage>;
    id: string;
}>) {
    const section = sections.find((entry) => entry.id === id);
    const pageId = section?.coreSection || section?.id || SettingsSection.General;
    return sections.find((entry) => entry.id === pageId);
}
