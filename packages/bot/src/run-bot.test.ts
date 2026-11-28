import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {type BotHost} from './agent-storm-client.js';
import {BotAiProvider} from './bot-ai.js';
import {type AnyBotDefinition} from './bot-definition.js';
import {BotAiRunStatus, BotRunResult} from './protocol.js';
import {runBotOnce} from './run-bot.js';

function createStubHost() {
    const calls: string[] = [];
    const host: BotHost = {
        isInAgentStorm: false,
        askQuestion() {
            return Promise.resolve(undefined);
        },
        startThread({prompt, ai, env}) {
            calls.push(`thread ${ai.model} ${JSON.stringify(env)}: ${prompt}`);
            return Promise.resolve({
                threadId: undefined,
            });
        },
        createWorktree() {
            return Promise.resolve({
                worktreePath: '',
            });
        },
        notify() {
            return Promise.resolve();
        },
        readLastUserInputAt() {
            return Promise.resolve(undefined);
        },
        report(line) {
            calls.push(`report: ${line}`);
            return Promise.resolve();
        },
        runAi({execute, ai}) {
            calls.push(`ai ${ai.model}: ${execute.prompt}`);
            return Promise.resolve(BotAiRunStatus.Finished);
        },
        finishRun({result}) {
            calls.push(`finish: ${result}`);
            return Promise.resolve();
        },
        close() {},
    };
    return {
        host,
        calls,
    };
}

const baseBot: AnyBotDefinition = {
    description: 'Test bot.',
    interval: {
        minutes: 1,
    },
    ai: {
        provider: BotAiProvider.Claude,
        model: 'base-model',
    },
    execute: {
        prompt: 'static',
    },
};

describe(runBotOnce.name, () => {
    it('runs setup again after each AI run, up to the follow-up limit', async () => {
        const {host, calls} = createStubHost();
        const result = await runBotOnce({
            botName: 'loop',
            bot: {
                ...baseBot,
                async execute({run}) {
                    await run.report(`pass ${run.pass} after ${run.aiStatus}`);
                    return {
                        prompt: `prompt ${run.pass}`,
                    };
                },
            },
            args: {},
            host,
            aiOverride: {
                model: 'override-model',
            },
        });
        assert.deepEquals(
            {
                result,
                calls,
            },
            {
                result: BotRunResult.Succeeded,
                calls: [
                    'report: pass 0 after undefined',
                    'ai override-model: prompt 0',
                    `report: pass 1 after ${BotAiRunStatus.Finished}`,
                    'ai override-model: prompt 1',
                    `report: pass 2 after ${BotAiRunStatus.Finished}`,
                    'ai override-model: prompt 2',
                    `finish: ${BotRunResult.Succeeded}`,
                ],
            },
        );
    });
    it('records a run with no reports and no AI as nothing to do', async () => {
        const {host, calls} = createStubHost();
        const result = await runBotOnce({
            botName: 'idle',
            bot: {
                ...baseBot,
                execute() {
                    return undefined;
                },
            },
            args: {},
            host,
        });
        assert.deepEquals(calls, [
            `finish: ${BotRunResult.NothingToDo}`,
        ]);
        assert.strictEquals(result, BotRunResult.NothingToDo);
    });
    it('starts threads on the resolved model and env, counting them as something done', async () => {
        const {host, calls} = createStubHost();
        const result = await runBotOnce({
            botName: 'starter',
            bot: {
                ...baseBot,
                env: {
                    shared: 'bot',
                    botOnly: 'bot',
                },
                async execute({agentStorm}) {
                    await agentStorm.startThread({
                        prompt: 'Pick this up.',
                        env: {
                            shared: 'thread',
                        },
                    });
                    return undefined;
                },
            },
            args: {},
            host,
            aiOverride: {
                model: 'override-model',
            },
        });
        assert.deepEquals(
            {
                result,
                calls,
            },
            {
                result: BotRunResult.Succeeded,
                calls: [
                    'thread override-model {"shared":"thread","botOnly":"bot"}: Pick this up.',
                    `finish: ${BotRunResult.Succeeded}`,
                ],
            },
        );
    });
    it('finishes as failed when an AI run fails', async () => {
        const {host, calls} = createStubHost();
        const result = await runBotOnce({
            botName: 'failing',
            bot: baseBot,
            args: {},
            host: {
                ...host,
                runAi({execute}) {
                    calls.push(`failed ai: ${execute.prompt}`);
                    return Promise.resolve(BotAiRunStatus.Failed);
                },
            },
        });
        assert.deepEquals(
            {
                result,
                calls,
            },
            {
                result: BotRunResult.Failed,
                calls: [
                    'failed ai: static',
                    'report: The AI run failed.',
                    `finish: ${BotRunResult.Failed}`,
                ],
            },
        );
    });
    it('reports a thrown setup as a failed run', async () => {
        const {host, calls} = createStubHost();
        const result = await runBotOnce({
            botName: 'broken',
            bot: {
                ...baseBot,
                execute() {
                    throw new Error('nope');
                },
            },
            args: {},
            host,
        });
        assert.deepEquals(
            {
                result,
                calls,
            },
            {
                result: BotRunResult.Failed,
                calls: [
                    `finish: ${BotRunResult.Failed}`,
                ],
            },
        );
    });
});
