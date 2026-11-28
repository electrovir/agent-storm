import {InMemorySessionStore, query} from '@anthropic-ai/claude-agent-sdk';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudePluginDir, claudePluginName} from '../agent-storm-skills.js';
import {createClaudeProvider} from './claude-provider.js';

const installedCopyDescription = 'The installed marketplace copy.';

/**
 * A Claude Code config folder whose settings enable a marketplace copy of Agent Storm's plugin, the
 * way a repo enables it for people who don't run Agent Storm. Claude Code installs it on its own
 * when a session starts.
 */
async function createInstalledCopyConfig(root: string) {
    const marketplaceDir = join(root, 'marketplace');
    await cp(claudePluginDir, join(marketplaceDir, 'plugin'), {
        recursive: true,
    });
    const skillsDir = join(marketplaceDir, 'plugin', 'skills');
    await Promise.all(
        (await readdir(skillsDir)).map(async (skillName) => {
            const skillPath = join(skillsDir, skillName, 'SKILL.md');
            await writeFile(
                skillPath,
                (await readFile(skillPath, 'utf8')).replace(
                    /^description: .*$/m,
                    `description: ${installedCopyDescription}`,
                ),
            );
        }),
    );
    await mkdir(join(marketplaceDir, '.claude-plugin'));
    await writeFile(
        join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
            name: claudePluginName,
            owner: {
                name: 'test',
            },
            plugins: [
                {
                    name: claudePluginName,
                    source: './plugin',
                },
            ],
        }),
    );
    const configDir = join(root, 'config');
    await mkdir(configDir);
    await writeFile(
        join(configDir, 'settings.json'),
        JSON.stringify({
            extraKnownMarketplaces: {
                [claudePluginName]: {
                    source: {
                        source: 'directory',
                        path: marketplaceDir,
                    },
                },
            },
            enabledPlugins: {
                [`${claudePluginName}@${claudePluginName}`]: true,
            },
        }),
    );
    return configDir;
}

function selectPluginSkills(
    commands: ReadonlyArray<
        Readonly<{
            name: string;
            description: string;
        }>
    >,
) {
    return commands
        .filter((command) => command.name.startsWith(`${claudePluginName}:`))
        .map((command) => {
            return {
                name: command.name,
                isInstalledCopy: command.description.includes(installedCopyDescription),
            };
        })
        .toSorted((first, second) => first.name.localeCompare(second.name));
}

describe('claude provider plugins', () => {
    it("lists each skill once and uses Agent Storm's own copy when the plugin is also installed", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-provider-')));
        const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
        try {
            process.env.CLAUDE_CONFIG_DIR = await createInstalledCopyConfig(root);
            const skillNames = (await readdir(join(claudePluginDir, 'skills'))).toSorted();

            /** Without this, a marketplace copy that never loaded would pass the check below. */
            const prompt = (async function* () {})();
            const installedOnlyQuery = query({
                prompt,
                options: {
                    cwd: root,
                },
            });
            try {
                assert.deepEquals(
                    selectPluginSkills(await installedOnlyQuery.supportedCommands()),
                    skillNames.map((skillName) => {
                        return {
                            name: `${claudePluginName}:${skillName}`,
                            isInstalledCopy: true,
                        };
                    }),
                );
            } finally {
                installedOnlyQuery.close();
            }

            assert.deepEquals(
                selectPluginSkills(
                    await createClaudeProvider(new InMemorySessionStore()).listCommands({
                        cwd: root,
                    }),
                ),
                skillNames.map((skillName) => {
                    return {
                        name: `${claudePluginName}:${skillName}`,
                        isInstalledCopy: false,
                    };
                }),
            );
        } finally {
            if (originalConfigDir == undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
            }
            await rm(root, {
                recursive: true,
                force: true,
            });
        }
    });
});
