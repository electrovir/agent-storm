import {
    agentStormConfigBaseName,
    agentStormConfigShape,
    type AgentStormConfig,
} from '@agent-storm/config';
import {assert, check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    removeUndefinedValues,
    type Overwrite,
    type PartialWithUndefined,
} from '@augment-vir/common';
import {findConfigFile, parseConfigContents} from 'config-vir';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertValidShape, nullableShape} from 'object-shape-tester';
import {assertBotDefinition, type AnyBotDefinition} from './bot-definition.js';
import {standalonePolicyShape, type StandalonePolicy} from './standalone-policy.js';

const botNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/**
 * In a package without `"type": "module"`, tsx loads a `.ts` file as CommonJS, which puts its
 * `export default` one `default` deeper than an ES module's.
 */
function unwrapDefaultExport(value: unknown) {
    return check.isObject(value) && check.hasKey(value, 'default') ? value.default : value;
}

/**
 * A repo's config, read and checked.
 *
 * @category Internal
 */
export type LoadedAgentStormConfig = Readonly<{
    configPath: string;
    config: Overwrite<
        AgentStormConfig,
        PartialWithUndefined<{
            standalone: StandalonePolicy;
        }>
    >;
}>;

/**
 * Reads the `.agent-storm/agent-storm.config.*` file in the repo at `directory`. TS configs need
 * `tsx`, which this package depends on.
 *
 * @category Internal
 */
export async function loadAgentStormConfig(directory: string) {
    const configPath = await findConfigFile({
        directory,
        baseName: agentStormConfigBaseName,
    });
    if (!configPath) {
        throw new Error(`Found no ${agentStormConfigBaseName}.* file in '${directory}'.`);
    }
    const config = unwrapDefaultExport(
        await parseConfigContents({
            configPath,
        }),
    );
    assertValidShape(
        config,
        agentStormConfigShape,
        {},
        `'${configPath}' isn't a valid Agent Storm config.`,
    );
    /** `@agent-storm/config` only types the policy's values as strings. */
    assertValidShape(
        config.standalone,
        nullableShape(standalonePolicyShape),
        {},
        `'${configPath}' has an invalid standalone policy.`,
    );
    Object.keys(config.bots || {}).forEach((name) => {
        assert.matches(
            name,
            botNamePattern,
            `Bot name '${name}' in '${configPath}' may only hold letters, digits, and dashes.`,
        );
    });
    return {
        configPath,
        config: config satisfies AgentStormConfig as LoadedAgentStormConfig['config'],
    };
}

async function importBotModule(modulePath: string) {
    const {tsImport} = await import('tsx/esm/api');
    const loadedModule: unknown = await tsImport(pathToFileURL(modulePath).href, import.meta.url);
    return unwrapDefaultExport(unwrapDefaultExport(loadedModule));
}

/**
 * Loads one of the config's bots, importing its module when the config lists it by path.
 *
 * @category Internal
 */
export async function loadBot({
    configPath,
    config,
    name,
}: Readonly<
    LoadedAgentStormConfig & {
        name: string;
    }
>) {
    const entry = config.bots?.[name];
    if (!entry) {
        throw new Error(
            `'${configPath}' has no bot named '${name}'. Its bots: ${Object.keys(config.bots || {}).join(', ') || 'none'}.`,
        );
    }
    const bot = check.isString(entry)
        ? await importBotModule(resolve(dirname(configPath), entry))
        : entry;
    try {
        assertBotDefinition(bot);
    } catch (error) {
        throw new Error(
            check.isString(entry)
                ? `The default export of '${entry}' isn't a bot: ${extractErrorMessage(error)}`
                : `Bot '${name}' is invalid: ${extractErrorMessage(error)}`,
            {
                cause: error,
            },
        );
    }
    return bot;
}

/**
 * A loaded bot's entry in {@link listBots}.
 *
 * @category Internal
 */
export function toBotListEntry({name, bot}: Readonly<{name: string; bot: AnyBotDefinition}>) {
    return {
        name,
        description: bot.description,
        interval: removeUndefinedValues(bot.interval),
        ai: bot.ai,
        limits: bot.limits,
        error: undefined,
    };
}

/**
 * Every bot in the config, each with the error that kept it from loading, if any.
 *
 * @category Internal
 */
export async function listBots(loaded: LoadedAgentStormConfig) {
    return {
        bots: await Promise.all(
            Object.keys(loaded.config.bots || {}).map(async (name) => {
                try {
                    return toBotListEntry({
                        name,
                        bot: await loadBot({
                            ...loaded,
                            name,
                        }),
                    });
                } catch (error) {
                    return {
                        name,
                        description: '',
                        interval: {},
                        ai: undefined,
                        limits: undefined,
                        error: extractErrorMessage(error),
                    };
                }
            }),
        ),
    };
}
