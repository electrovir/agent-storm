// cspell:words forgejo, gitea

import {
    SettingsSection,
    type AnySettingsSectionContribution,
    type SettingsSectionContribution,
} from '@agent-storm/core/frontend';
import {getEnumValues} from '@augment-vir/common';

/** A page of the Settings modal, whether core's own or a plugin's. */
export type SettingsSectionPage = Omit<AnySettingsSectionContribution, 'listAfter'>;

/**
 * Core's own sections. Their rows are built from the schema keys listed here, in order, and the
 * dedicated element each section renders is chosen by the modal.
 */
const coreSettingsSections: Readonly<
    Record<SettingsSection, Omit<SettingsSectionContribution, 'id' | 'listAfter' | 'render'>>
> = {
    [SettingsSection.General]: {
        label: 'General',
        group: 'App',
        searchTerms: [
            'scrollback',
            'https',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [
            'disableUpdateCheck',
            'tlsCertPath',
        ],
    },
    [SettingsSection.Terminal]: {
        label: 'Terminal',
        group: 'App',
        searchTerms: [],
        schemaCardTitle: undefined,
        schemaKeys: [
            'useWebgl',
            'terminalClickableLinks',
        ],
    },
    [SettingsSection.Sidebar]: {
        label: 'Sidebar',
        group: 'App',
        searchTerms: [],
        schemaCardTitle: undefined,
        schemaKeys: [
            'sidebarGrouping',
            'sidebarSorting',
            'onlyShowRecent',
        ],
    },
    [SettingsSection.Activities]: {
        label: 'Activities',
        group: 'App',
        searchTerms: [
            'plugin',
            'vertical tab',
            'dashboard',
            'debug',
        ],
        schemaCardTitle: undefined,
        schemaKeys: [],
    },
    [SettingsSection.Ai]: {
        label: 'AI',
        group: 'Agents',
        searchTerms: [
            'avatar',
            'command',
            'model',
            'default ai',
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
            'override',
        ],
        schemaKeys: [
            'postWorktreeCmd',
        ],
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

/**
 * Every section in tab order: core's in their own order, each plugin section right after the core
 * section it names, in the order the plugins were registered.
 */
export function listSettingsSections(
    pluginSections: ReadonlyArray<AnySettingsSectionContribution>,
): ReadonlyArray<SettingsSectionPage> {
    return getEnumValues(SettingsSection).flatMap((section) => {
        return [
            {
                ...coreSettingsSections[section],
                id: section,
            },
            ...pluginSections.filter((pluginSection) => pluginSection.listAfter === section),
        ];
    });
}

/**
 * The section `id` names, or the General section when none does, like a plugin's section from
 * before that plugin was turned off.
 */
export function findSettingsSection({
    sections,
    id,
}: Readonly<{
    sections: ReadonlyArray<SettingsSectionPage>;
    id: string;
}>) {
    return (
        sections.find((section) => section.id === id) ||
        sections.find((section) => section.id === SettingsSection.General)
    );
}
