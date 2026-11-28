import {type SlashCommand} from '@anthropic-ai/claude-agent-sdk';
import {getObjectTypedEntries, removeDuplicates} from '@augment-vir/common';
import {access, readdir, readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {defineShape, parseJsonWithShape, recordShape} from 'object-shape-tester';
import {ComposerCommandKind, ComposerCommandSource} from '../../build-api.js';
import {claudePluginName} from '../agent-storm-skills.js';

/** The names of the commands and skills found in each place Claude Code reads them from. */
export type ClaudeCommandOrigins = Readonly<{
    repoSkills: ReadonlyArray<string>;
    repoCommands: ReadonlyArray<string>;
    personalSkills: ReadonlyArray<string>;
    personalCommands: ReadonlyArray<string>;
    accountSkills: ReadonlyArray<string>;
    /** Qualified with the plugin's name, as `plugin:skill`. */
    pluginSkills: ReadonlyArray<string>;
    /** Qualified with the plugin's name, as `plugin:command`. */
    pluginCommands: ReadonlyArray<string>;
    /** Agent Storm's own skills, qualified like a plugin's. */
    agentStormSkills: ReadonlyArray<string>;
}>;

const installedPluginsShape = defineShape({
    plugins: recordShape({
        keys: '',
        values: [
            {
                installPath: '',
            },
        ],
    }),
});

async function readSkillNames(skillsDir: string) {
    const entries = await readdir(skillsDir).catch(() => []);
    const hasSkill = await Promise.all(
        entries.map(async (entry) => {
            return access(join(skillsDir, entry, 'SKILL.md')).then(
                () => true,
                () => false,
            );
        }),
    );
    return entries.filter((_entry, index) => hasSkill[index]);
}

/**
 * A command in a subfolder is listed under both its own name and its folder-qualified name
 * (`folder:name`), since Claude Code versions differ on which one they use.
 */
async function readCommandNames(commandsDir: string) {
    const files = await readdir(commandsDir, {
        recursive: true,
    }).catch(() => []);
    return files
        .filter((file) => file.endsWith('.md'))
        .flatMap((file) => {
            const parts = file.slice(0, -'.md'.length).split(/[/\\]/);
            return removeDuplicates([
                parts.join(':'),
                parts.at(-1) || '',
            ]);
        });
}

/**
 * `cwd` and each folder above it, stopping before the home folder. Recursive, so the return type
 * can't be inferred.
 */
function listRepoFolders({cwd, home}: Readonly<{cwd: string; home: string}>): string[] {
    const parent = dirname(cwd);
    return cwd === home || parent === cwd
        ? []
        : [
              cwd,
              ...listRepoFolders({
                  cwd: parent,
                  home,
              }),
          ];
}

/**
 * Finds where the commands and skills a Claude session in `cwd` can see are defined. `configDir` is
 * Claude Code's config folder, `~/.claude` unless `CLAUDE_CONFIG_DIR` moves it.
 */
export async function readClaudeCommandOrigins({
    cwd,
    configDir,
    home,
    agentStormSkillsDir,
}: Readonly<{
    cwd: string;
    configDir: string;
    home: string;
    agentStormSkillsDir: string;
}>): Promise<ClaudeCommandOrigins> {
    const repoFolders = listRepoFolders({
        cwd,
        home,
    });
    const syncedDir = join(configDir, 'skills', syncedSkillsFolder);
    const installedPlugins = await readFile(
        join(configDir, 'plugins', 'installed_plugins.json'),
        'utf8',
    )
        .then((contents) => {
            return parseJsonWithShape(contents, installedPluginsShape, {
                allowExtraKeys: true,
            });
        })
        .catch(() => undefined);
    const pluginInstalls = getObjectTypedEntries(installedPlugins?.plugins || {}).flatMap(
        ([
            key,
            installs,
        ]) => {
            const pluginName = key.split('@')[0] || key;
            return installs.map((install) => {
                return {
                    pluginName,
                    installPath: install.installPath,
                };
            });
        },
    );
    const [
        repoSkills,
        repoCommands,
        personalSkills,
        personalCommands,
        accountSkills,
        pluginSkills,
        pluginCommands,
        agentStormSkills,
    ] = await Promise.all([
        Promise.all(repoFolders.map((folder) => readSkillNames(join(folder, '.claude', 'skills')))),
        Promise.all(
            repoFolders.map((folder) => readCommandNames(join(folder, '.claude', 'commands'))),
        ),
        readSkillNames(join(configDir, 'skills')),
        readCommandNames(join(configDir, 'commands')),
        readdir(syncedDir)
            .catch(() => [])
            .then((accounts) => {
                return Promise.all(
                    accounts.map((account) => readSkillNames(join(syncedDir, account))),
                );
            }),
        Promise.all(
            pluginInstalls.map(async ({pluginName, installPath}) => {
                return (await readSkillNames(join(installPath, 'skills'))).map((name) => {
                    return `${pluginName}:${name}`;
                });
            }),
        ),
        Promise.all(
            pluginInstalls.map(async ({pluginName, installPath}) => {
                return (await readCommandNames(join(installPath, 'commands'))).map((name) => {
                    return `${pluginName}:${name}`;
                });
            }),
        ),
        readSkillNames(agentStormSkillsDir),
    ]);
    return {
        repoSkills: repoSkills.flat(),
        repoCommands: repoCommands.flat(),
        personalSkills,
        personalCommands,
        accountSkills: accountSkills.flat(),
        pluginSkills: pluginSkills.flat(),
        pluginCommands: pluginCommands.flat(),
        agentStormSkills: agentStormSkills.map((name) => `${claudePluginName}:${name}`),
    };
}

/** The folder, inside a `skills` folder, that the account's skills are synced into. */
export const syncedSkillsFolder = 'synced';

/** Claude Code's config folder for this process. */
export function findClaudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * Claude Code marks only its own commands, so the rest are matched by name to the folders they're
 * defined in. Personal beats repo and a skill beats a command, the order Claude Code itself picks
 * between same-named definitions in.
 */
export function classifyClaudeCommands({
    commands,
    origins,
}: Readonly<{
    commands: ReadonlyArray<Readonly<SlashCommand>>;
    origins: ClaudeCommandOrigins;
}>) {
    return commands
        .filter((command) => !command.name.startsWith('_'))
        .map((command) => {
            const unqualifiedName = command.name.split(':').at(-1) || command.name;
            const origin = command.builtin
                ? {
                      kind: ComposerCommandKind.Command,
                      source: ComposerCommandSource.BuiltIn,
                  }
                : claudeCommandOriginOrder.find((entry) => {
                      return origins[entry.originKey].includes(
                          entry.isMatchedUnqualified ? unqualifiedName : command.name,
                      );
                  }) || {
                      kind: ComposerCommandKind.Command,
                      source: ComposerCommandSource.Other,
                  };
            return {
                name: command.name,
                description: command.description,
                argumentHint: command.argumentHint,
                kind: origin.kind,
                source: origin.source,
            };
        });
}

/** Where a command could be defined, in the order a same-named one is matched to them. */
const claudeCommandOriginOrder: ReadonlyArray<
    Readonly<{
        originKey: keyof ClaudeCommandOrigins;
        kind: ComposerCommandKind;
        source: ComposerCommandSource;
        isMatchedUnqualified?: boolean | undefined;
    }>
> = [
    {
        originKey: 'personalSkills',
        kind: ComposerCommandKind.Skill,
        source: ComposerCommandSource.Personal,
    },
    {
        originKey: 'repoSkills',
        kind: ComposerCommandKind.Skill,
        source: ComposerCommandSource.Repo,
    },
    {
        originKey: 'personalCommands',
        kind: ComposerCommandKind.Command,
        source: ComposerCommandSource.Personal,
    },
    {
        originKey: 'repoCommands',
        kind: ComposerCommandKind.Command,
        source: ComposerCommandSource.Repo,
    },
    {
        originKey: 'agentStormSkills',
        kind: ComposerCommandKind.Skill,
        source: ComposerCommandSource.AgentStorm,
    },
    {
        originKey: 'pluginSkills',
        kind: ComposerCommandKind.Skill,
        source: ComposerCommandSource.Plugin,
    },
    {
        originKey: 'pluginCommands',
        kind: ComposerCommandKind.Command,
        source: ComposerCommandSource.Plugin,
    },
    {
        /**
         * A synced skill that a same-named repo or personal one hides is listed qualified, as
         * `anthropic-skills:name`.
         */
        originKey: 'accountSkills',
        kind: ComposerCommandKind.Skill,
        source: ComposerCommandSource.Synced,
        isMatchedUnqualified: true,
    },
];

/** A currency sign and a name, alone between whitespace. Only known names count as mentions. */
const skillMentionPattern = /(^|\s)\p{Sc}([\w:-]+)(?=\s|$)/gu;

/** Whether `text` has anything shaped like a `$name` mention, known name or not. */
export function hasSkillMention(text: string) {
    return !text.matchAll(skillMentionPattern).next().done;
}

/**
 * Rewrites the `$name` mentions of `commandNames` in `text` into the content Claude Code expands
 * them from, or returns `text` unchanged when it has none. Claude Code expands a skill only when
 * `/name` starts a text block, and only one per message, so the last mention starts the final
 * block, which carries everything after it as the skill's arguments. Earlier mentions become
 * `/name` in plain text in a block before it. Mentions before `mentionsFrom` stay as typed. Ported
 * from T3 Code's `ClaudeSkillDispatch.ts`.
 */
export function dispatchClaudeSkillMentions({
    text,
    commandNames,
    mentionsFrom,
}: Readonly<{
    text: string;
    commandNames: ReadonlyArray<string>;
    mentionsFrom: number;
}>):
    | string
    | {
          type: 'text';
          text: string;
      }[] {
    const mentions = [
        ...text.matchAll(skillMentionPattern),
    ].flatMap((match) => {
        const name = match[2] || '';
        const start = match.index + (match[1]?.length || 0);
        return commandNames.includes(name) && start >= mentionsFrom
            ? [
                  {
                      name,
                      start,
                      end: match.index + match[0].length,
                  },
              ]
            : [];
    });
    const last = mentions.at(-1);
    if (!last) {
        return text;
    }
    const withSlashes = mentions
        .reduce(
            (accumulated, mention) => {
                return {
                    text: `${accumulated.text}${text.slice(accumulated.cursor, mention.start)}/${mention.name}`,
                    cursor: mention.end,
                };
            },
            {
                text: '',
                cursor: 0,
            },
        )
        .text.concat(text.slice(last.end))
        .trimEnd();
    const commandBlock = {
        type: 'text' as const,
        text: `/${last.name}${text.slice(last.end)}`.trimEnd(),
    };
    return text.slice(0, last.start).trim()
        ? [
              {
                  type: 'text',
                  text: withSlashes,
              },
              commandBlock,
          ]
        : [
              commandBlock,
          ];
}
