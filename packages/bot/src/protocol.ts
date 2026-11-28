import {anyDurationShape} from 'date-vir';
import {defineShape, enumShape, nullableShape, recordShape} from 'object-shape-tester';
import {botAiShape} from './bot-ai.js';
import {botLimitsShape} from './bot-limits.js';

/**
 * How a bot run ended.
 *
 * @category Internal
 */
export enum BotRunResult {
    /** The run reported something, ran AI, or asked something of Agent Storm. */
    Succeeded = 'succeeded',
    /** The run did none of what {@link BotRunResult.Succeeded} counts. */
    NothingToDo = 'nothingToDo',
    Failed = 'failed',
}

/**
 * Where an AI run stands.
 *
 * @category Main
 */
export enum BotAiRunStatus {
    Running = 'running',
    /** Paused on a question or an approval only the user can answer. */
    Waiting = 'waiting',
    Finished = 'finished',
    Failed = 'failed',
    /** Agent Storm stopped it at the bot's `maxAiRunDuration` limit. */
    TimedOut = 'timedOut',
    /** Agent Storm stopped it, or never started it, at the bot's `maxSpendPerDayUsd` limit. */
    OverSpendLimit = 'overSpendLimit',
}

/**
 * How an AI run ended.
 *
 * @category Main
 */
export type EndedBotAiRunStatus = Exclude<
    BotAiRunStatus,
    BotAiRunStatus.Running | BotAiRunStatus.Waiting
>;

/**
 * The CLI flag through which Agent Storm hands a run its {@link BotRunFile}.
 *
 * @category Internal
 */
export const agentStormRunFlag = 'agent-storm-run';

/**
 * How Agent Storm runs `agent-storm-bot` in a repo. `--no` keeps npx from downloading a package of
 * that name when the repo doesn't have it installed. Without `--`, npm claims the CLI's own flags
 * and fails on the ones it doesn't know.
 *
 * @category Internal
 */
export const botCliCommand = 'npx --no -- agent-storm-bot';

/**
 * The JSON file Agent Storm writes for one run and passes through {@link agentStormRunFlag}. The CLI
 * deletes it once read, since it holds the run's token.
 *
 * @category Internal
 */
export const botRunFileShape = defineShape({
    /** The Bots plugin's loopback server, without a trailing slash. */
    url: '',
    /** Sent as a bearer token. Only valid for this run. */
    token: '',
    runId: '',
    /** The Bots tab's model setting, which wins over the bot's own. */
    ai: nullableShape(botAiShape),
});

/**
 * The contents of a {@link botRunFileShape} file.
 *
 * @category Internal
 */
export type BotRunFile = typeof botRunFileShape.runtimeType;

const environmentShape = recordShape({
    keys: '',
    values: '',
});

/**
 * One bot in {@link botListShape}.
 *
 * @category Internal
 */
export const botListEntryShape = defineShape({
    name: '',
    description: '',
    interval: anyDurationShape,
    ai: nullableShape(botAiShape),
    limits: nullableShape(botLimitsShape),
    /** Why the bot's definition failed to load. The other fields are then blank. */
    error: nullableShape(''),
});

/**
 * Each call the CLI makes to Agent Storm's Bots plugin during a run: a POST to `<url>/<call name>`
 * with a JSON body, authorized by the run's token.
 *
 * @category Internal
 */
export const botCalls = {
    /** Keeps the run from being marked interrupted. Every other call does the same. */
    heartbeat: {
        requestShape: defineShape({}),
        responseShape: defineShape({}),
    },
    /** Adds a line to the run's entry in the Bots tab's run history. */
    report: {
        requestShape: defineShape({
            line: '',
        }),
        responseShape: defineShape({}),
    },
    /**
     * The bot's definition as the run loaded it, which replaces the bot's listing, so an edit to a
     * file the bot imports shows in the Bots tab after the bot's next run.
     */
    reportDefinition: {
        requestShape: botListEntryShape,
        responseShape: defineShape({}),
    },
    finishRun: {
        requestShape: defineShape({
            result: enumShape(BotRunResult),
            error: nullableShape(''),
        }),
        responseShape: defineShape({}),
    },
    /**
     * Sends the run's AI work to the bot's thread, which its AI Chat tab shows. A `cwd`, `env`, or
     * provider other than the thread started with starts a new thread in its place.
     */
    startAi: {
        requestShape: defineShape({
            text: '',
            ai: botAiShape,
            env: environmentShape,
            /** The repo root when unset. */
            cwd: nullableShape(''),
            isUnattended: nullableShape(false),
        }),
        responseShape: defineShape({
            /** Unset when the bot's spend limit kept the AI run from starting. */
            threadId: nullableShape(''),
        }),
    },
    readAi: {
        requestShape: defineShape({
            threadId: '',
        }),
        responseShape: defineShape({
            status: enumShape(BotAiRunStatus),
        }),
    },
    askQuestion: {
        requestShape: defineShape({
            question: '',
            options: [
                '',
            ],
            isFreeTextAllowed: false,
        }),
        responseShape: defineShape({
            questionId: '',
        }),
    },
    readAnswer: {
        requestShape: defineShape({
            questionId: '',
        }),
        responseShape: defineShape({
            isPending: false,
            /** Empty when the user dismissed the question. */
            answer: nullableShape(''),
        }),
    },
    /** Starts a thread in Agent Storm's sidebar that the user picks up. */
    startThread: {
        requestShape: defineShape({
            text: '',
            ai: botAiShape,
            title: nullableShape(''),
            isInWorktree: false,
            /** The repo root when unset. */
            cwd: nullableShape(''),
            isUnattended: nullableShape(false),
            /** Extra environment variables for the thread's model, saved with the thread. */
            env: nullableShape(environmentShape),
        }),
        responseShape: defineShape({
            /** Unset when the bot's spend limit kept the thread from starting. */
            threadId: nullableShape(''),
        }),
    },
    createWorktree: {
        requestShape: defineShape({
            name: '',
        }),
        responseShape: defineShape({
            worktreePath: '',
        }),
    },
    notify: {
        requestShape: defineShape({
            title: '',
            body: '',
        }),
        responseShape: defineShape({}),
    },
    readLastUserInput: {
        requestShape: defineShape({}),
        responseShape: defineShape({
            /** Epoch milliseconds. Unset until the user's first input. */
            lastUserInputAt: nullableShape(0),
        }),
    },
} as const;

/**
 * The name of one of {@link botCalls}.
 *
 * @category Internal
 */
export type BotCallName = keyof typeof botCalls;

/**
 * The request body of one of {@link botCalls}.
 *
 * @category Internal
 */
export type BotCallRequest<Name extends BotCallName> =
    (typeof botCalls)[Name]['requestShape']['runtimeType'];

/**
 * The response body of one of {@link botCalls}.
 *
 * @category Internal
 */
export type BotCallResponse<Name extends BotCallName> =
    (typeof botCalls)[Name]['responseShape']['runtimeType'];

/**
 * What `agent-storm-bot --list` prints as its last line of output, for Agent Storm to find a repo's
 * bots.
 *
 * @category Internal
 */
export const botListShape = defineShape({
    bots: [
        botListEntryShape,
    ],
});

/**
 * The output of `agent-storm-bot --list`.
 *
 * @category Internal
 */
export type BotList = typeof botListShape.runtimeType;
