import {
    defaultSettings,
    ForgeType,
    GitHubPollingDisableReason,
    settingsShape,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {resolve} from 'node:path';
import {checkValidShape} from 'object-shape-tester';
import {splitLegacyConfig} from './settings-migration.js';
import {
    migrateTerminalClickableLinks,
    parseSettings,
    stripSettingsDefaults,
    withSettingsDefaults,
} from './settings.js';

describe(splitLegacyConfig.name, () => {
    it('moves app state out and legacy keys under forges.github', () => {
        const {settings, appState} = splitLegacyConfig({
            legacyConfig: {
                useWebgl: false,
                postWorktreeCmd: null,
                disabledGitHubPolling: true,
                githubPollingAutoDisable: {
                    reason: GitHubPollingDisableReason.RateLimited,
                    disabledUntilMs: 1000,
                },
                trustedBotLogins: [
                    'my-bot',
                ],
                repos: [
                    {
                        path: resolve('/tmp/project-a'),
                        postWorktreeCmd: 'npm ci',
                        lastInteractedAtMs: 5,
                    },
                    {
                        path: resolve('/tmp/project-b'),
                        postWorktreeCmd: null,
                    },
                ],
            },
            legacyReviewConfig: {
                defaultInitCmd: 'npm i',
                repos: [],
            },
        });

        assert.deepEquals(
            {
                settings: selectFrom(settings, {
                    useWebgl: true,
                    postWorktreeCmd: true,
                    folderPostWorktreeCmds: true,
                    review: true,
                    forges: {
                        [ForgeType.Github]: true,
                    },
                }),
                appState,
            },
            {
                settings: {
                    useWebgl: false,
                    postWorktreeCmd: '',
                    folderPostWorktreeCmds: [
                        {
                            folder: resolve('/tmp/project-a'),
                            postWorktreeCmd: 'npm ci',
                        },
                    ],
                    review: {
                        initCmd: 'npm i',
                        repos: [],
                    },
                    forges: {
                        [ForgeType.Github]: {
                            disabledGitHubPolling: true,
                            trustedBotLogins: [
                                'my-bot',
                            ],
                        },
                    },
                },
                appState: {
                    repos: [
                        {
                            path: resolve('/tmp/project-a'),
                            lastInteractedAtMs: 5,
                        },
                        {
                            path: resolve('/tmp/project-b'),
                        },
                    ],
                    githubPollingAutoDisable: {
                        reason: GitHubPollingDisableReason.RateLimited,
                        disabledUntilMs: 1000,
                    },
                },
            },
        );
    });
});

describe(withSettingsDefaults.name, () => {
    it('fills in missing forges and missing settings inside a forge', () => {
        const settings = withSettingsDefaults({
            defaults: defaultSettings,
            saved: {
                forges: {
                    [ForgeType.Github]: {
                        trustedBotLogins: [
                            'my-bot',
                        ],
                    },
                },
            },
        });

        assert.isTrue(checkValidShape(settings, settingsShape));
        assert.deepEquals(settings.forges, {
            ...defaultSettings.forges,
            [ForgeType.Github]: {
                ...defaultSettings.forges[ForgeType.Github],
                trustedBotLogins: [
                    'my-bot',
                ],
            },
        });
    });
});

describe(stripSettingsDefaults.name, () => {
    it('keeps only what differs from the defaults', () => {
        const stripped = stripSettingsDefaults({
            defaults: defaultSettings,
            settings: {
                ...defaultSettings,
                useWebgl: false,
                forges: {
                    ...defaultSettings.forges,
                    [ForgeType.Github]: {
                        ...defaultSettings.forges[ForgeType.Github],
                        trustedBotLogins: [
                            'my-bot',
                        ],
                    },
                },
            },
        });

        assert.deepEquals(stripped, {
            useWebgl: false,
            forges: {
                [ForgeType.Github]: {
                    trustedBotLogins: [
                        'my-bot',
                    ],
                },
            },
        });
    });
});

describe(migrateTerminalClickableLinks.name, () => {
    it('moves the old top-level setting under the terminal plugin', () => {
        assert.deepEquals(
            migrateTerminalClickableLinks({
                useWebgl: false,
                terminalClickableLinks: false,
                pluginSettings: {
                    other: {
                        a: 1,
                    },
                },
            }),
            {
                useWebgl: false,
                pluginSettings: {
                    other: {
                        a: 1,
                    },
                    terminal: {
                        clickableLinks: false,
                    },
                },
            },
        );
    });

    it('keeps a value already stored under the plugin', () => {
        assert.deepEquals(
            migrateTerminalClickableLinks({
                terminalClickableLinks: false,
                pluginSettings: {
                    terminal: {
                        clickableLinks: true,
                    },
                },
            }),
            {
                pluginSettings: {
                    terminal: {
                        clickableLinks: true,
                    },
                },
            },
        );
    });

    it('leaves settings without the old key alone', () => {
        assert.isUndefined(
            migrateTerminalClickableLinks({
                useWebgl: false,
            }),
        );
    });
});

describe(parseSettings.name, () => {
    it('reads a settings file that still has the old terminal links key', () => {
        assert.deepEquals(
            parseSettings({
                rawSettings: {
                    terminalClickableLinks: false,
                },
                source: 'a test',
            }).pluginSettings,
            {
                terminal: {
                    clickableLinks: false,
                },
            },
        );
    });
});
