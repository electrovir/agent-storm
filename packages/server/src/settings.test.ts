// cspell:words opencode

import {
    defaultSettings,
    ForgeType,
    GitHubPollingDisableReason,
    settingsShape,
    type AiDefinition,
    type Settings,
} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {checkValidShape} from 'object-shape-tester';
import {splitLegacyConfig} from './settings-migration.js';
import {
    resolveFolderAi,
    setFolderAiId,
    stripSettingsDefaults,
    withFallbackAi,
    withSettingsDefaults,
} from './settings.js';

function aiDefinition({
    name,
    resumeSessionCommand,
}: Readonly<{name: string; resumeSessionCommand: string}>): AiDefinition {
    return {
        id: `${name}-id`,
        name,
        resumeSessionCommand,
        newSessionCommand: resumeSessionCommand,
    };
}

const claude = aiDefinition({
    name: 'Claude',
    resumeSessionCommand: 'claude --continue',
});
const codex = aiDefinition({
    name: 'Codex',
    resumeSessionCommand: 'codex resume --last',
});
const openCode = aiDefinition({
    name: 'Opencode',
    resumeSessionCommand: 'opencode',
});

function settingsWithAis(overrides: Readonly<Partial<Settings>>): Settings {
    return {
        ...defaultSettings,
        aiDefinitions: [
            claude,
            codex,
        ],
        defaultAiId: claude.id,
        ...overrides,
    };
}

function resolveNames(parameters: Parameters<typeof resolveFolderAi>[0]) {
    const resolved = resolveFolderAi(parameters);
    return {
        ai: resolved.ai?.name,
        inheritedAi: resolved.inheritedAi?.name,
    };
}

describe(resolveFolderAi.name, () => {
    it('prefers a folder override, then a fallback folder, then the default', () => {
        const settings = settingsWithAis({
            folderAiIds: [
                {
                    folder: '/tmp/project-a',
                    aiId: codex.id,
                },
                {
                    folder: '/tmp/project-root',
                    aiId: codex.id,
                },
            ],
        });

        assert.deepEquals(
            [
                resolveNames({
                    settings,
                    folderLayers: [],
                    folder: '/tmp/project-a',
                }),
                resolveNames({
                    settings,
                    folderLayers: [],
                    folder: '/tmp/project-b',
                }),
                resolveNames({
                    settings,
                    folderLayers: [],
                    folder: '/tmp/project-root/worktree-a',
                    fallbackFolders: ['/tmp/project-root'],
                }),
            ],
            [
                {
                    ai: 'Codex',
                    inheritedAi: 'Claude',
                },
                {
                    ai: 'Claude',
                    inheritedAi: 'Claude',
                },
                {
                    ai: 'Codex',
                    inheritedAi: 'Codex',
                },
            ],
        );
    });

    it("uses the nearest folder file's default and AIs before the user's default", () => {
        const resolved = resolveFolderAi({
            settings: settingsWithAis({
                folderAiIds: [
                    {
                        folder: '/tmp/project-a',
                        aiId: 'deleted-id',
                    },
                ],
            }),
            folderLayers: [
                {
                    defaultAiId: openCode.id,
                    aiDefinitions: [
                        openCode,
                        {
                            ...claude,
                            name: 'Replaced Claude',
                        },
                    ],
                },
                {
                    defaultAiId: codex.id,
                },
            ],
            folder: '/tmp/project-a',
        });

        assert.deepEquals(
            {
                ai: resolved.ai?.name,
                names: resolved.aiDefinitions.map((definition) => definition.name),
            },
            {
                ai: 'Opencode',
                names: [
                    'Claude',
                    'Codex',
                    'Opencode',
                ],
            },
        );
    });

    it('falls back to the first definition when the default is missing', () => {
        assert.strictEquals(
            resolveFolderAi({
                settings: settingsWithAis({
                    defaultAiId: 'deleted-id',
                }),
                folderLayers: [],
                folder: '/tmp/project-a',
            }).ai?.name,
            'Claude',
        );
    });

    it('resolves to nothing when no AI is defined', () => {
        assert.isUndefined(
            resolveFolderAi({
                settings: defaultSettings,
                folderLayers: [],
                folder: '/tmp/project-a',
            }).ai,
        );
    });
});

describe(setFolderAiId.name, () => {
    it('adds, replaces, and clears folder overrides', () => {
        const withOverride = setFolderAiId({
            settings: settingsWithAis({}),
            folder: '/tmp/project-a',
            aiId: codex.id,
        });
        const withReplacement = setFolderAiId({
            settings: withOverride,
            folder: '/tmp/project-a',
            aiId: claude.id,
        });
        const cleared = setFolderAiId({
            settings: withReplacement,
            folder: '/tmp/project-a',
            aiId: '',
        });

        assert.deepEquals(
            {
                withOverride: withOverride.folderAiIds,
                withReplacement: withReplacement.folderAiIds,
                cleared: cleared.folderAiIds,
            },
            {
                withOverride: [
                    {
                        folder: '/tmp/project-a',
                        aiId: codex.id,
                    },
                ],
                withReplacement: [
                    {
                        folder: '/tmp/project-a',
                        aiId: claude.id,
                    },
                ],
                cleared: [],
            },
        );
    });
});

describe(withFallbackAi.name, () => {
    it('stands in a claude definition, and makes it the default, when none is defined', () => {
        const settings = withFallbackAi(defaultSettings);

        assert.deepEquals(
            {
                definitions: settings.aiDefinitions.map((definition) => {
                    return selectFrom(definition, {
                        name: true,
                        resumeSessionCommand: true,
                    });
                }),
                isDefault: settings.defaultAiId === settings.aiDefinitions[0]?.id,
            },
            {
                definitions: [
                    {
                        name: 'Claude',
                        resumeSessionCommand: 'claude',
                    },
                ],
                isDefault: true,
            },
        );
    });

    it('leaves settings that already have definitions alone', () => {
        const settings = settingsWithAis({});

        assert.deepEquals(withFallbackAi(settings), settings);
    });
});

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
                    'flax-bot',
                ],
                repos: [
                    {
                        path: '/tmp/project-a',
                        postWorktreeCmd: 'npm ci',
                        lastInteractedAtMs: 5,
                    },
                    {
                        path: '/tmp/project-b',
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
                            folder: '/tmp/project-a',
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
                                'flax-bot',
                            ],
                        },
                    },
                },
                appState: {
                    repos: [
                        {
                            path: '/tmp/project-a',
                            lastInteractedAtMs: 5,
                        },
                        {
                            path: '/tmp/project-b',
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
                            'flax-bot',
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
                    'flax-bot',
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
                            'flax-bot',
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
                        'flax-bot',
                    ],
                },
            },
        });
    });
});
