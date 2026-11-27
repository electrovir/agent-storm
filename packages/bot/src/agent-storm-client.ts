import {assert} from '@augment-vir/assert';
import {
    extractErrorMessage,
    log,
    type MaybePromise,
    type PartialWithUndefined,
    shellQuote,
    wait,
} from '@augment-vir/common';
import {askQuestion, runShellCommand} from '@augment-vir/node';
import {type AnyDuration, convertDuration} from 'date-vir';
import {assertValidShape} from 'object-shape-tester';
import {buildUrl} from 'url-vir';
import {createAiCommand, createAiText} from './ai-command.js';
import {type BotAi} from './bot-ai.js';
import {type BotExecute} from './bot-definition.js';
import {
    BotAiRunStatus,
    type BotCallName,
    type BotCallRequest,
    type BotCallResponse,
    botCalls,
    type BotRunFile,
    type BotRunResult,
} from './protocol.js';
import {
    type resolveStandalonePolicy,
    StandaloneQuestion,
    StandaloneThread,
} from './standalone-policy.js';

/**
 * What a bot can ask of Agent Storm. Outside Agent Storm, each call follows the config's
 * `standalone` policy instead of failing.
 *
 * @category Main
 */
export type AgentStormClient = Readonly<{
    /** False when the bot runs from the bare CLI or a deployment. */
    isInAgentStorm: boolean;
    /**
     * Shows the question in the bot's Bots tab, with a notification, and waits for the user's
     * answer: one of `options`, or their own text when `isFreeTextAllowed`. `undefined` when the
     * user dismisses it.
     */
    askQuestion(
        params: Readonly<
            {
                question: string;
                options: ReadonlyArray<string>;
            } & PartialWithUndefined<{
                isFreeTextAllowed: boolean;
            }>
        >,
    ): Promise<string | undefined>;
    /**
     * Starts a thread in Agent Storm's sidebar for the user to pick up, without waiting for it.
     * Runs on the bot's model unless `ai` is set. `threadId` is `undefined` outside Agent Storm.
     */
    startThread(
        params: Readonly<
            BotExecute &
                PartialWithUndefined<{
                    title: string;
                    /** Starts the thread in a new worktree of the repo. */
                    isInWorktree: boolean;
                }>
        >,
    ): Promise<
        Readonly<{
            threadId: string | undefined;
        }>
    >;
    /**
     * Makes a worktree of the repo on a new branch named `name`, beside the repo's checkout. Inside
     * Agent Storm, the repo's post-worktree command runs in it too.
     */
    createWorktree(
        params: Readonly<{
            name: string;
        }>,
    ): Promise<
        Readonly<{
            worktreePath: string;
        }>
    >;
    /** Sends an Agent Storm notification. Logged outside Agent Storm. */
    notify(
        params: Readonly<{
            title: string;
            body: string;
        }>,
    ): Promise<void>;
}>;

/**
 * The client plus what the runner itself needs from wherever the bot runs.
 *
 * @category Internal
 */
export type BotHost = AgentStormClient &
    Readonly<{
        /** Logs `line`, and inside Agent Storm adds it to the run's history in the Bots tab. */
        report(line: string): Promise<void>;
        /** @returns Whether the AI run finished without failing. */
        runAi(
            params: Readonly<{
                execute: BotExecute;
                ai: BotAi;
                env: Readonly<Record<string, string>>;
            }>,
        ): Promise<boolean>;
        /** Records how the run ended. Does nothing outside Agent Storm. */
        finishRun(
            params: Readonly<{
                result: BotRunResult;
                error: string | undefined;
            }>,
        ): Promise<void>;
        /** Stops anything that would keep the process alive. */
        close(): void;
    }>;

/**
 * Shared by both hosts.
 *
 * @category Internal
 */
export type BotHostParams = Readonly<{
    /** The model `startThread` uses unless its caller sets one. */
    defaultAi: BotAi;
    /** The repo root, where the AI and git run. */
    cwd: string;
}>;

/** Names a branch and a sibling folder, and is quoted into shell commands. */
const worktreeNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]*(\.[a-zA-Z0-9_-]+)*$/;

/**
 * The host for a run that Agent Storm started: every call goes to the Bots plugin.
 *
 * @category Internal
 */
export function createConnectedHost({
    runFile,
    defaultAi,
    pollInterval = {
        seconds: 2,
    },
}: Readonly<
    Pick<BotHostParams, 'defaultAi'> & {
        runFile: Readonly<BotRunFile>;
    } & PartialWithUndefined<{
            pollInterval: AnyDuration;
        }>
>): BotHost {
    async function callAgentStorm<const Name extends BotCallName>(
        name: Name,
        request: BotCallRequest<Name>,
    ): Promise<BotCallResponse<Name>> {
        const response = await fetch(
            buildUrl(runFile.url, {
                paths: [
                    name,
                ],
            }).href,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${runFile.token}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(request),
            },
        );
        if (!response.ok) {
            throw new Error(
                `Agent Storm rejected '${name}' (${response.status}): ${await response.text()}`,
            );
        }
        const body: unknown = await response.json();
        assertValidShape(body, botCalls[name].responseShape);
        return body;
    }

    /**
     * Calls `read` until it gives a value. Each call doubles as the run's heartbeat.
     *
     * Annotated because it's recursive.
     */
    async function pollUntilDefined<T>(read: () => Promise<T | undefined>): Promise<T> {
        const value = await read();
        if (value != undefined) {
            return value;
        }
        await wait(pollInterval);
        return await pollUntilDefined(read);
    }

    /** Agent Storm marks a run interrupted when it stops hearing from it. */
    const heartbeat = setInterval(
        async () => {
            try {
                await callAgentStorm('heartbeat', {});
            } catch (error) {
                log.warning(`Agent Storm heartbeat failed: ${extractErrorMessage(error)}`);
            }
        },
        convertDuration(
            {
                seconds: 30,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
    heartbeat.unref();

    return {
        isInAgentStorm: true,
        async askQuestion({question, options, isFreeTextAllowed}) {
            const {questionId} = await callAgentStorm('askQuestion', {
                question,
                options: [
                    ...options,
                ],
                isFreeTextAllowed: !!isFreeTextAllowed,
            });
            log.info(`Waiting for an answer in Agent Storm's Bots tab: ${question}`);
            const {answer} = await pollUntilDefined(async () => {
                const {isPending, answer} = await callAgentStorm('readAnswer', {
                    questionId,
                });
                return isPending
                    ? undefined
                    : {
                          answer: answer || undefined,
                      };
            });
            return answer;
        },
        async startThread({title, isInWorktree, ...execute}) {
            const ai = execute.ai || defaultAi;
            return await callAgentStorm('startThread', {
                text: createAiText({
                    execute,
                    provider: ai.provider,
                }),
                ai,
                title,
                isInWorktree: !!isInWorktree,
            });
        },
        async createWorktree({name}) {
            return await callAgentStorm('createWorktree', {
                name,
            });
        },
        async notify(params) {
            await callAgentStorm('notify', params);
        },
        async report(line) {
            log.info(line);
            await callAgentStorm('report', {
                line,
            });
        },
        async runAi({execute, ai, env}) {
            const {threadId} = await callAgentStorm('startAi', {
                text: createAiText({
                    execute,
                    provider: ai.provider,
                }),
                ai,
                env: {
                    ...env,
                },
            });
            log.info(`AI is working in the bot's AI Chat tab (thread ${threadId}).`);
            const status = await pollUntilDefined(async () => {
                const aiRun = await callAgentStorm('readAi', {
                    threadId,
                });
                return aiRun.status === BotAiRunStatus.Running ||
                    aiRun.status === BotAiRunStatus.Waiting
                    ? undefined
                    : aiRun.status;
            });
            return status === BotAiRunStatus.Finished;
        },
        async finishRun({result, error}) {
            await callAgentStorm('finishRun', {
                result,
                error,
            });
        },
        close() {
            clearInterval(heartbeat);
        },
    };
}

/**
 * Runs `execute` through the provider's CLI in `cwd`, with its output in this terminal.
 *
 * @returns Whether the CLI exited cleanly.
 */
async function runAiCli({
    execute,
    ai,
    env,
    cwd,
}: Readonly<{
    execute: BotExecute;
    ai: BotAi;
    env: Readonly<Record<string, string>>;
    cwd: string;
}>) {
    const command = createAiCommand({
        execute,
        ai,
    });
    log.faint(`> ${command}`);
    /**
     * A failed model run doesn't reject: in a looping bot that would end every later run, and the
     * next run retries whatever this one left unfinished.
     */
    const result = await runShellCommand(command, {
        hookUpToConsole: true,
        cwd,
        env: {
            ...process.env,
            ...env,
        },
    });
    if (result.exitCode) {
        log.warning(`${ai.provider} exited with code ${result.exitCode}.`);
    }
    return !result.exitCode;
}

/**
 * The host for a run outside Agent Storm: AI runs through its CLI here, and Agent Storm-only calls
 * follow the standalone policy.
 *
 * @category Internal
 */
export function createStandaloneHost({
    defaultAi,
    cwd,
    policy,
    isTerminal = process.stdin.isTTY,
}: Readonly<
    BotHostParams & {
        policy: ReturnType<typeof resolveStandalonePolicy>;
    } & PartialWithUndefined<{
            /** Whether someone can answer a question in this process's terminal. */
            isTerminal: boolean;
        }>
>): BotHost {
    const questionAnswerers: Readonly<
        Record<
            StandaloneQuestion,
            (
                params: Readonly<{
                    question: string;
                    options: ReadonlyArray<string>;
                }>,
            ) => MaybePromise<string | undefined>
        >
    > = {
        [StandaloneQuestion.Ignore]() {
            return undefined;
        },
        [StandaloneQuestion.FirstOption]({options}) {
            return options[0];
        },
        async [StandaloneQuestion.Terminal]({question, options}) {
            if (!isTerminal) {
                return options[0];
            }
            const answer = (
                await askQuestion(
                    [
                        question,
                        ...options.map((option, index) => `  ${index + 1}. ${option}`),
                        '> ',
                    ].join('\n'),
                )
            ).trim();
            const optionIndex = Number(answer) - 1;
            return options[optionIndex] ?? (answer || undefined);
        },
        [StandaloneQuestion.Fail]({question}) {
            throw new Error(`A bot asked a question outside Agent Storm: ${question}`);
        },
    };
    const threadStarters: Readonly<
        Record<
            StandaloneThread,
            (execute: Readonly<BotExecute>) => MaybePromise<{
                threadId: undefined;
            }>
        >
    > = {
        [StandaloneThread.Ignore]() {
            log.faint('Skipped starting a thread outside Agent Storm.');
            return {
                threadId: undefined,
            };
        },
        async [StandaloneThread.RunHeadless](execute) {
            await runAiCli({
                execute,
                ai: execute.ai || defaultAi,
                env: execute.env || {},
                cwd,
            });
            return {
                threadId: undefined,
            };
        },
        [StandaloneThread.Fail]() {
            throw new Error('A bot started a thread outside Agent Storm.');
        },
    };

    return {
        isInAgentStorm: false,
        async askQuestion(params) {
            return await questionAnswerers[policy.question](params);
        },
        async startThread(params) {
            /** A headless run has no thread to title or put in a worktree. */
            return await threadStarters[policy.thread](params);
        },
        async createWorktree({name}) {
            assert.matches(
                name,
                worktreeNamePattern,
                `Worktree name '${name}' may only hold letters, digits, dots, dashes, and underscores.`,
            );
            const worktreePath = `../${name}`;
            await runShellCommand(
                [
                    'git worktree add -b',
                    shellQuote(name),
                    shellQuote(worktreePath),
                ].join(' '),
                {
                    cwd,
                    rejectOnError: true,
                },
            );
            return {
                worktreePath: (
                    await runShellCommand(
                        [
                            'git -C',
                            shellQuote(worktreePath),
                            'rev-parse --path-format=absolute --show-toplevel',
                        ].join(' '),
                        {
                            cwd,
                            rejectOnError: true,
                        },
                    )
                ).stdout.trim(),
            };
        },
        notify({title, body}) {
            log.info(`${title}: ${body}`);
            return Promise.resolve();
        },
        report(line) {
            log.info(line);
            return Promise.resolve();
        },
        async runAi(params) {
            return await runAiCli({
                ...params,
                cwd,
            });
        },
        finishRun() {
            return Promise.resolve();
        },
        close() {},
    };
}
