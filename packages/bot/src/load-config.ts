import {assert, check} from '@augment-vir/assert';
import {extractErrorMessage, getObjectTypedKeys} from '@augment-vir/common';
import {findConfigFile, parseConfigContents} from 'config-vir';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    assertValidShape,
    defineShape,
    nullableShape,
    recordShape,
    unknownShape,
} from 'object-shape-tester';
import {type AgentStormConfig, agentStormConfigBaseName} from './agent-storm-config.js';
import {assertBotDefinition} from './bot-definition.js';
import {standalonePolicyShape} from './standalone-policy.js';

const botNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

/**
 * In a package without `"type": "module"`, tsx loads a `.ts` file as CommonJS, which puts its
 * `export default` one `default` deeper than an ES module's.
 */
function unwrapDefaultExport(value: unknown) {
    return check.isObject(value) && check.hasKey(value, 'default') ? value.default : value;
}

/** Bots stay `unknown` here: a TS config's bots hold functions, which only {@link loadBot} checks. */
const agentStormConfigShape = defineShape({
    bots: recordShape({
        keys: '',
        values: unknownShape(),
    }),
    standalone: nullableShape(standalonePolicyShape),
});

/**
 * A repo's config, read and checked.
 *
 * @category Internal
 */
export type LoadedAgentStormConfig = Readonly<{
    configPath: string;
    config: AgentStormConfig;
}>;

/**
 * Reads the `agent-storm.config.*` file in `directory`. TS configs need `tsx`, which this package
 * depends on.
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
    getObjectTypedKeys(config.bots).forEach((name) => {
        assert.matches(
            name,
            botNamePattern,
            `Bot name '${name}' in '${configPath}' may only hold letters, digits, and dashes.`,
        );
    });
    return {
        configPath,
        config: config satisfies Partial<
            Record<keyof AgentStormConfig, unknown>
        > as AgentStormConfig,
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
    const entry = config.bots[name];
    if (!entry) {
        throw new Error(
            `'${configPath}' has no bot named '${name}'. Its bots: ${getObjectTypedKeys(config.bots).join(', ') || 'none'}.`,
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
 * Every bot in the config, each with the error that kept it from loading, if any.
 *
 * @category Internal
 */
export async function listBots(loaded: LoadedAgentStormConfig) {
    return {
        bots: await Promise.all(
            getObjectTypedKeys(loaded.config.bots).map(async (name) => {
                try {
                    const bot = await loadBot({
                        ...loaded,
                        name,
                    });
                    return {
                        name,
                        description: bot.description,
                        interval: bot.interval,
                        ai: bot.ai,
                        error: undefined,
                    };
                } catch (error) {
                    return {
                        name,
                        description: '',
                        interval: {},
                        ai: undefined,
                        error: extractErrorMessage(error),
                    };
                }
            }),
        ),
    };
}
