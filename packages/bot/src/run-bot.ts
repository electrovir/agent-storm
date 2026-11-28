import {check} from '@augment-vir/assert';
import {extractErrorMessage, log, type PartialWithUndefined} from '@augment-vir/common';
import {type ParsedArgs} from 'cli-vir';
import {type AgentStormClient, type BotHost} from './agent-storm-client.js';
import {type BotAi, mergeBotAi} from './bot-ai.js';
import {type AnyBotDefinition} from './bot-definition.js';
import {BotAiRunStatus, BotRunResult, type EndedBotAiRunStatus} from './protocol.js';

/**
 * How many times a setup function runs again after an AI run within one run, so a setup that keeps
 * asking for AI can't hold the run forever. Whatever is left waits for the next run.
 */
const maxFollowUpPasses = 2;

/**
 * Runs a bot once: its setup, the AI run it asks for, and up to a few follow-up setup passes that
 * act on the AI's result. Reports how the run ended to `host`. A failed AI run fails the whole run,
 * even though the follow-up passes still run. An AI run stopped at one of the bot's limits
 * doesn't.
 *
 * @category Internal
 * @returns How the run ended.
 */
export async function runBotOnce({
    botName,
    bot,
    args,
    host,
    aiOverride,
}: Readonly<
    {
        botName: string;
        bot: AnyBotDefinition;
        args: ParsedArgs<any>;
        host: BotHost;
    } & PartialWithUndefined<{
        /** Wins over the bot's and the setup's model, such as the Bots tab's setting. */
        aiOverride: Readonly<PartialWithUndefined<BotAi>>;
    }>
>) {
    const counts = {
        reports: 0,
        aiRuns: 0,
        failedAiRuns: 0,
        /** Calls that ask something of Agent Storm, which make a run more than nothing to do. */
        actions: 0,
    };

    const agentStorm: AgentStormClient = {
        isInAgentStorm: host.isInAgentStorm,
        async askQuestion(params) {
            counts.actions++;
            return await host.askQuestion(params);
        },
        async startThread(params) {
            counts.actions++;
            return await host.startThread({
                ...params,
                ai: mergeBotAi(params.ai || bot.ai, aiOverride),
                env: {
                    ...bot.env,
                    ...params.env,
                },
            });
        },
        async createWorktree(params) {
            counts.actions++;
            return await host.createWorktree(params);
        },
        async notify(params) {
            counts.actions++;
            await host.notify(params);
        },
        async readLastUserInputAt() {
            return await host.readLastUserInputAt();
        },
    };

    /** Annotated because it's recursive. */
    async function runPass(pass: number, aiStatus: EndedBotAiRunStatus | undefined): Promise<void> {
        const execute = check.isFunction(bot.execute)
            ? await bot.execute({
                  args,
                  agentStorm,
                  run: {
                      botName,
                      pass,
                      aiStatus,
                      async report(line) {
                          counts.reports++;
                          await host.report(line);
                      },
                  },
              })
            : pass
              ? undefined
              : bot.execute;
        if (!execute) {
            return;
        }
        const status = await host.runAi({
            execute,
            ai: mergeBotAi(execute.ai || bot.ai, aiOverride),
            env: {
                ...bot.env,
                ...execute.env,
            },
        });
        counts.aiRuns++;
        if (status === BotAiRunStatus.Failed) {
            counts.failedAiRuns++;
            await host.report('The AI run failed.');
        }
        if (check.isFunction(bot.execute) && pass < maxFollowUpPasses) {
            await runPass(pass + 1, status);
        }
    }

    try {
        await runPass(0, undefined);
        if (counts.failedAiRuns) {
            await host.finishRun({
                result: BotRunResult.Failed,
                error: 'An AI run failed.',
            });
            return BotRunResult.Failed;
        }
        const result =
            counts.reports || counts.aiRuns || counts.actions
                ? BotRunResult.Succeeded
                : BotRunResult.NothingToDo;
        await host.finishRun({
            result,
            error: undefined,
        });
        return result;
    } catch (error) {
        log.error(`Bot '${botName}' failed: ${extractErrorMessage(error)}`);
        await host.finishRun({
            result: BotRunResult.Failed,
            error: extractErrorMessage(error),
        });
        return BotRunResult.Failed;
    }
}
