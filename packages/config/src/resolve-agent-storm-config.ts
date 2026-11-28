import {
    ConfigFileType,
    deduceFileType,
    findConfigFilesUpward,
    parseConfigContents,
} from 'config-vir';
import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {assertValidShape} from 'object-shape-tester';
import {
    agentStormConfigBaseName,
    agentStormConfigShape,
    type AgentStormConfig,
} from './agent-storm-config.js';

/**
 * TS and JS configs run code when they're read, and a folder's files come from whoever wrote the
 * repo. Agent Storm runs them only once the user approves them, and this reader has no approvals.
 */
const executableFileTypes: ReadonlyArray<ConfigFileType> = [
    ConfigFileType.Ts,
    ConfigFileType.Js,
];

async function readAgentStormConfigFile(configPath: string) {
    const config = await parseConfigContents({
        configPath,
    });
    assertValidShape(
        config,
        agentStormConfigShape,
        {},
        `'${configPath}' isn't a valid Agent Storm config.`,
    );
    return config;
}

function findNearestSetting(
    configs: ReadonlyArray<Readonly<AgentStormConfig>>,
    selectValue: (config: Readonly<AgentStormConfig>) => string | undefined,
) {
    return configs.map((config) => selectValue(config)?.trim()).find(Boolean) || '';
}

function isExecutableConfig(configPath: string) {
    const fileType = deduceFileType(configPath);
    return !fileType || executableFileTypes.includes(fileType);
}

/**
 * The folder settings that apply in `folder`, read from every `.agent-storm/agent-storm.config.*`
 * file from `folder` up to the home folder, the nearest file that sets each one winning, as Agent
 * Storm reads them. Unlike Agent Storm, it never runs a TS or JS config, listing it in
 * `skippedConfigPaths` instead, and it has no user defaults to fall back to, so an unset setting is
 * empty. The commands a config sets are returned unapproved.
 *
 * @category Internal
 */
export async function resolveAgentStormConfig(folder: string) {
    const home = homedir();
    const foundPaths = (
        await findConfigFilesUpward({
            startDirectory: folder,
            stopDirectory: home,
            baseName: agentStormConfigBaseName,
        })
    ).filter((configPath) => {
        /** `~/.agent-storm` is Agent Storm's data folder, not a folder's settings. */
        return dirname(dirname(configPath)) !== home;
    });
    const configPaths = foundPaths.filter((configPath) => !isExecutableConfig(configPath));
    const configs = await Promise.all(configPaths.map(readAgentStormConfigFile));
    return {
        configPaths,
        skippedConfigPaths: foundPaths.filter(isExecutableConfig),
        postWorktreeCmd: findNearestSetting(configs, (config) => config.postWorktreeCmd),
        reviewSkill: findNearestSetting(configs, (config) => config.reviewSkill),
    };
}
