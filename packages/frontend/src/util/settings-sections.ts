// cspell:words forgejo, gitea

import {type configJsonSchema} from '@agent-storm/common';
import {type PartialWithUndefined} from '@augment-vir/common';
import {SettingsSection} from './app-context.js';

/** Config keys that a section's own element renders instead of a generic row. */
type CustomConfigKey = 'aiDefinitions' | 'defaultAiId' | 'repos' | 'folderAiIds' | 'forges';

export type SchemaConfigKey = Exclude<keyof typeof configJsonSchema.properties, CustomConfigKey>;

/**
 * The section each remaining config key shows in, as a row built from its schema. Rows list in this
 * order.
 */
export const schemaConfigKeySections: Readonly<Record<SchemaConfigKey, SettingsSection>> = {
    disableUpdateCheck: SettingsSection.General,
    tlsCertPath: SettingsSection.General,
    useWebgl: SettingsSection.Terminal,
    terminalClickableLinks: SettingsSection.Terminal,
    sidebarGrouping: SettingsSection.Sidebar,
    sidebarSorting: SettingsSection.Sidebar,
    onlyShowRecent: SettingsSection.Sidebar,
    diffLayout: SettingsSection.Diff,
    diffHideWhitespace: SettingsSection.Diff,
    diffCollapseUnchanged: SettingsSection.Diff,
    postWorktreeCmd: SettingsSection.Folders,
};

export const settingsSections: Readonly<
    Record<
        SettingsSection,
        Readonly<{
            label: string;
            group: string;
            /** Matched by the nav search, beside the section's label and its rows' text. */
            searchTerms: ReadonlyArray<string>;
        }> &
            PartialWithUndefined<{
                /** Titles the card of the section's schema settings, for a section with more cards. */
                schemaCardTitle: string;
            }>
    >
> = {
    [SettingsSection.General]: {
        label: 'General',
        group: 'App',
        searchTerms: [
            'scrollback',
            'debug',
            'https',
        ],
    },
    [SettingsSection.Terminal]: {
        label: 'Terminal',
        group: 'App',
        searchTerms: [],
    },
    [SettingsSection.Sidebar]: {
        label: 'Sidebar',
        group: 'App',
        searchTerms: [],
    },
    [SettingsSection.Diff]: {
        label: 'Diff',
        group: 'App',
        searchTerms: [],
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
    },
    [SettingsSection.Review]: {
        label: 'Review',
        group: 'Agents',
        searchTerms: [
            'init command',
            'pull request',
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
    },
    [SettingsSection.Maintenance]: {
        label: 'Maintenance',
        group: 'System',
        searchTerms: [
            'daemon',
            'pty',
            'restart',
        ],
    },
};
