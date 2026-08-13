// cspell:words opencode

import {defaultConfig, type AiDefinition, type Config} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {getFolderAiDefinition, migrateAiConfig, setFolderAiId} from './config.js';

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

function configWithAis(overrides: Readonly<Partial<Config>>): Config {
    return {
        ...defaultConfig,
        aiDefinitions: [
            claude,
            codex,
            openCode,
        ],
        defaultAiId: claude.id,
        ...overrides,
    };
}

describe(getFolderAiDefinition.name, () => {
    it('prefers a folder override, then a fallback folder, then the default', () => {
        const config = configWithAis({
            folderAiIds: [
                {
                    folder: '/tmp/project-a',
                    aiId: codex.id,
                },
                {
                    folder: '/tmp/project-root',
                    aiId: openCode.id,
                },
            ],
        });

        assert.deepEquals(
            {
                overridden: getFolderAiDefinition({
                    config,
                    folder: '/tmp/project-a',
                })?.name,
                fallback: getFolderAiDefinition({
                    config,
                    folder: '/tmp/project-b',
                })?.name,
                inherited: getFolderAiDefinition({
                    config,
                    folder: '/tmp/project-root/worktree-a',
                    fallbackFolders: ['/tmp/project-root'],
                })?.name,
            },
            {
                overridden: 'Codex',
                fallback: 'Claude',
                inherited: 'Opencode',
            },
        );
    });

    it('falls back to the first definition when the default is missing', () => {
        assert.strictEquals(
            getFolderAiDefinition({
                config: configWithAis({
                    defaultAiId: 'deleted-id',
                }),
                folder: '/tmp/project-a',
            })?.name,
            'Claude',
        );
    });

    it('resolves to nothing when no AI is defined', () => {
        assert.isUndefined(
            getFolderAiDefinition({
                config: {
                    ...defaultConfig,
                    aiDefinitions: [],
                },
                folder: '/tmp/project-a',
            }),
        );
    });
});

describe(setFolderAiId.name, () => {
    it('adds, replaces, and clears folder overrides', () => {
        const withOverride = setFolderAiId({
            config: configWithAis({}),
            folder: '/tmp/project-a',
            aiId: codex.id,
        });
        const withReplacement = setFolderAiId({
            config: withOverride,
            folder: '/tmp/project-a',
            aiId: openCode.id,
        });
        const cleared = setFolderAiId({
            config: withReplacement,
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
                        aiId: openCode.id,
                    },
                ],
                cleared: [],
            },
        );
    });

    it('drops overrides pointing at a deleted AI', () => {
        const withOverride = setFolderAiId({
            config: configWithAis({}),
            folder: '/tmp/project-a',
            aiId: codex.id,
        });

        assert.deepEquals(
            setFolderAiId({
                config: {
                    ...withOverride,
                    aiDefinitions: [claude],
                },
                folder: '/tmp/project-b',
                aiId: claude.id,
            }).folderAiIds,
            [
                {
                    folder: '/tmp/project-b',
                    aiId: claude.id,
                },
            ],
        );
    });
});

describe(migrateAiConfig.name, () => {
    it('converts legacy commands into definitions and folder overrides', () => {
        const migrated = migrateAiConfig({
            ...defaultConfig,
            aiCmd: 'claude --continue',
            resetAiSessionCmd: '/clear',
            folderAiCmds: [
                {
                    folder: '/tmp/project-a',
                    aiCmd: 'codex',
                },
                /** Same commands as the global pair, so it needs no definition of its own. */
                {
                    folder: '/tmp/project-b',
                    aiCmd: 'claude --continue',
                    resetAiSessionCmd: '/clear',
                },
            ],
        });

        assert.deepEquals(
            {
                definitions: migrated.aiDefinitions.map((definition) =>
                    selectFrom(definition, {
                        name: true,
                        resumeSessionCommand: true,
                        newSessionCommand: true,
                    }),
                ),
                overriddenFolders: migrated.folderAiIds.map((entry) => entry.folder),
                defaultIsGlobalPair:
                    migrated.aiDefinitions.find(
                        (definition) => definition.id === migrated.defaultAiId,
                    )?.resumeSessionCommand === 'claude --continue',
            },
            {
                definitions: [
                    {
                        name: 'Claude',
                        resumeSessionCommand: 'claude --continue',
                        newSessionCommand: '/clear',
                    },
                    {
                        name: 'Codex',
                        resumeSessionCommand: 'codex',
                        newSessionCommand: '/clear',
                    },
                ],
                overriddenFolders: ['/tmp/project-a'],
                defaultIsGlobalPair: true,
            },
        );
    });

    it('seeds a claude definition for a config with nothing configured', () => {
        const migrated = migrateAiConfig(defaultConfig);

        assert.deepEquals(
            migrated.aiDefinitions.map((definition) =>
                selectFrom(definition, {
                    name: true,
                    resumeSessionCommand: true,
                }),
            ),
            [
                {
                    name: 'Claude',
                    resumeSessionCommand: 'claude',
                },
            ],
        );
    });

    it('leaves a config that already has definitions alone', () => {
        const config = configWithAis({});

        assert.deepEquals(migrateAiConfig(config), config);
    });
});
