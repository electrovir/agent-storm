import {extractErrorMessage, log, wait} from '@augment-vir/common';
import {FlagRequirement, parseArgs, parseStrippedArgs} from 'cli-vir';
import {convertDuration, getNowInIsoString} from 'date-vir';
import {readFile, rm} from 'node:fs/promises';
import {assertValidShape} from 'object-shape-tester';
import {createConnectedHost, createStandaloneHost} from './agent-storm-client.js';
import {BotAiEffort, BotAiProvider} from './bot-ai.js';
import {
    listBots,
    loadAgentStormConfig,
    loadBot,
    toBotListEntry,
    type LoadedAgentStormConfig,
} from './load-config.js';
import {botRunFileShape, BotRunResult} from './protocol.js';
import {runBotOnce} from './run-bot.js';
import {resolveStandalonePolicy} from './standalone-policy.js';

/** Reads the run file Agent Storm wrote, then deletes it, since it holds the run's token. */
async function takeRunFile(path: string) {
    const contents: unknown = JSON.parse(await readFile(path, 'utf8'));
    await rm(path, {
        force: true,
    });
    assertValidShape(contents, botRunFileShape);
    return contents;
}

async function loadCliBot({
    loaded,
    botName,
    botArgs,
}: Readonly<{
    loaded: LoadedAgentStormConfig;
    botName: string | undefined;
    botArgs: ReadonlyArray<string>;
}>) {
    if (!botName) {
        throw new Error('Name the bot to run, or pass --list to see the bots.');
    }
    const bot = await loadBot({
        ...loaded,
        name: botName,
    });
    return {
        botName,
        bot,
        args: parseStrippedArgs(botArgs, bot.args || {}, {
            commandDescription: `Arguments for the '${botName}' bot.`,
        }),
    };
}

async function runCli(importMeta: ImportMeta) {
    const cliArgs = parseArgs(
        process.argv,
        {
            once: {
                flag: {
                    valueRequirement: FlagRequirement.Blocked,
                },
                description: "Runs the bot once and exits, instead of on the bot's interval.",
            },
            list: {
                flag: {
                    valueRequirement: FlagRequirement.Blocked,
                },
                description: "Prints the config's bots as JSON and exits.",
            },
            provider: {
                flag: {
                    valueRequirement: FlagRequirement.Required,
                },
                type: BotAiProvider,
                description: "Overrides the bot's AI provider. Pass --model with it.",
            },
            model: {
                flag: {
                    valueRequirement: FlagRequirement.Required,
                },
                description: "Overrides the bot's AI model.",
            },
            effort: {
                flag: {
                    valueRequirement: FlagRequirement.Required,
                },
                type: BotAiEffort,
                description: "Overrides the bot's AI effort.",
            },
            agentStormRun: {
                flag: {
                    valueRequirement: FlagRequirement.Required,
                },
                description: 'Set by Agent Storm when it runs the bot.',
            },
            botName: {
                position: {
                    index: 0,
                    /** Everything after the bot name belongs to the bot, flags included. */
                    disableFlags: true,
                },
                description: 'The bot to run, as named in .agent-storm/agent-storm.config.',
            },
            botArgs: {
                position: {
                    rest: true,
                },
                description: "The bot's own arguments.",
            },
        },
        {
            binName: 'agent-storm-bot',
            packageJsonPath: undefined,
            importMeta,
            commandDescription:
                "Runs a bot from this directory's .agent-storm/agent-storm.config file. Put this command's flags before the bot name.",
        },
    );

    if (cliArgs.agentStormRun) {
        /** Taken before the bot loads, so a bot that fails to load still deletes it. */
        const runFile = await takeRunFile(cliArgs.agentStormRun);
        const host = createConnectedHost({
            runFile,
        });
        try {
            const cliBot = await loadCliBot({
                loaded: await loadAgentStormConfig(process.cwd()),
                botName: cliArgs.botName,
                botArgs: cliArgs.botArgs,
            });
            await host.reportDefinition(
                toBotListEntry({
                    name: cliBot.botName,
                    bot: cliBot.bot,
                }),
            );
            return await runBotOnce({
                ...cliBot,
                host,
                aiOverride: runFile.ai || undefined,
            });
        } catch (error) {
            log.error(extractErrorMessage(error));
            await host.finishRun({
                result: BotRunResult.Failed,
                error: extractErrorMessage(error),
            });
            return BotRunResult.Failed;
        } finally {
            host.close();
        }
    }

    const loaded = await loadAgentStormConfig(process.cwd());

    if (cliArgs.list) {
        process.stdout.write(`${JSON.stringify(await listBots(loaded))}\n`);
        return BotRunResult.Succeeded;
    }

    const {botName, bot, args} = await loadCliBot({
        loaded,
        botName: cliArgs.botName,
        botArgs: cliArgs.botArgs,
    });
    const runParams = {
        botName,
        bot,
        args,
        host: createStandaloneHost({
            cwd: process.cwd(),
            policy: resolveStandalonePolicy(bot.standalone, loaded.config.standalone),
        }),
        aiOverride: {
            provider: cliArgs.provider || undefined,
            model: cliArgs.model || undefined,
            effort: cliArgs.effort || undefined,
        },
    };

    if (cliArgs.once) {
        return await runBotOnce(runParams);
    }

    const intervalMilliseconds = convertDuration(bot.interval, {
        milliseconds: true,
    }).milliseconds;
    /** A looping bot runs until its process is stopped, such as by its deployment. */
    for (;;) {
        const startedAt = Date.now();
        log.faint(`Starting '${botName}' at ${getNowInIsoString()}.`);
        await runBotOnce(runParams);
        await wait({
            milliseconds: Math.max(0, startedAt + intervalMilliseconds - Date.now()),
        });
    }
}

/**
 * Runs the `agent-storm-bot` command and exits. `importMeta` is the bin script's, which the
 * command's arguments follow.
 */
export async function runAgentStormBotCli(importMeta: ImportMeta) {
    try {
        const result = await runCli(importMeta);
        process.exit(result === BotRunResult.Failed ? 1 : 0);
    } catch (error) {
        log.error(extractErrorMessage(error));
        process.exit(1);
    }
}
