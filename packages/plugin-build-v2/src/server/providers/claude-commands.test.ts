import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ComposerCommandKind, ComposerCommandSource} from '../../build-v2-api.js';
import {
    classifyClaudeCommands,
    dispatchClaudeSkillMentions,
    readClaudeCommandOrigins,
} from './claude-commands.js';

async function writeFiles(root: string, files: ReadonlyArray<string>) {
    await Promise.all(
        files.map(async (file) => {
            await mkdir(join(root, file, '..'), {
                recursive: true,
            });
            await writeFile(join(root, file), '');
        }),
    );
}

describe(readClaudeCommandOrigins.name, () => {
    it('finds skills and commands in each place Claude Code reads them from', async () => {
        const home = await mkdtemp(join(tmpdir(), 'claude-commands-'));
        try {
            const configDir = join(home, '.claude');
            const pluginDir = join(home, 'plugin-install');
            await writeFiles(home, [
                'repo/.claude/skills/deploy/SKILL.md',
                'repo/.claude/skills/not-a-skill/notes.md',
                'repo/.claude/commands/tools/lint.md',
                '.claude/skills/review/SKILL.md',
                '.claude/commands/standup.md',
                '.claude/skills/synced/account-id/pdf/SKILL.md',
                'plugin-install/skills/digest/SKILL.md',
                'plugin-install/commands/post.md',
                '.claude/plugins/installed_plugins.json',
            ]);
            await writeFile(
                join(configDir, 'plugins', 'installed_plugins.json'),
                JSON.stringify({
                    version: 2,
                    plugins: {
                        'slack@market': [
                            {
                                scope: 'user',
                                installPath: pluginDir,
                            },
                        ],
                    },
                }),
            );

            assert.deepEquals(
                await readClaudeCommandOrigins({
                    cwd: join(home, 'repo'),
                    configDir,
                    home,
                }),
                {
                    repoSkills: [
                        'deploy',
                    ],
                    repoCommands: [
                        'tools:lint',
                        'lint',
                    ],
                    personalSkills: [
                        'review',
                    ],
                    personalCommands: [
                        'standup',
                    ],
                    accountSkills: [
                        'pdf',
                    ],
                    pluginSkills: [
                        'slack:digest',
                    ],
                    pluginCommands: [
                        'slack:post',
                    ],
                },
            );
        } finally {
            await rm(home, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(classifyClaudeCommands.name, () => {
    const origins = {
        repoSkills: [
            'shared',
            'deploy',
        ],
        repoCommands: [],
        personalSkills: [
            'shared',
        ],
        personalCommands: [],
        accountSkills: [
            'deploy',
        ],
        pluginSkills: [],
        pluginCommands: [],
    };

    it('prefers personal over repo and finds hidden synced skills', () => {
        assert.deepEquals(
            classifyClaudeCommands({
                commands: [
                    {
                        name: 'compact',
                        description: '',
                        argumentHint: '',
                        builtin: true,
                    },
                    {
                        name: 'shared',
                        description: '',
                        argumentHint: '',
                    },
                    {
                        name: 'anthropic-skills:deploy',
                        description: '',
                        argumentHint: '',
                    },
                    {
                        name: '__remote-workflow',
                        description: '',
                        argumentHint: '',
                        builtin: true,
                    },
                ],
                origins,
            }).map((command) => {
                return [
                    command.name,
                    command.kind,
                    command.source,
                ];
            }),
            [
                [
                    'compact',
                    ComposerCommandKind.Command,
                    ComposerCommandSource.BuiltIn,
                ],
                [
                    'shared',
                    ComposerCommandKind.Skill,
                    ComposerCommandSource.Personal,
                ],
                [
                    'anthropic-skills:deploy',
                    ComposerCommandKind.Skill,
                    ComposerCommandSource.Synced,
                ],
            ],
        );
    });
});

describe(dispatchClaudeSkillMentions.name, () => {
    const commandNames = [
        'review',
        'deploy',
    ];

    it('starts the last block with the last mention', () => {
        assert.deepEquals(
            dispatchClaudeSkillMentions({
                text: 'use $review then $deploy to prod',
                commandNames,
                mentionsFrom: 0,
            }),
            [
                {
                    type: 'text',
                    text: 'use /review then /deploy to prod',
                },
                {
                    type: 'text',
                    text: '/deploy to prod',
                },
            ],
        );
    });

    it('sends one block when the mention starts the message', () => {
        assert.deepEquals(
            dispatchClaudeSkillMentions({
                text: '$review the diff',
                commandNames,
                mentionsFrom: 0,
            }),
            [
                {
                    type: 'text',
                    text: '/review the diff',
                },
            ],
        );
    });

    it('leaves amounts, unknown names, and earlier context alone', () => {
        assert.strictEquals(
            dispatchClaudeSkillMentions({
                text: '$review costs $5 and $unknown',
                commandNames,
                mentionsFrom: 1,
            }),
            '$review costs $5 and $unknown',
        );
    });
});
