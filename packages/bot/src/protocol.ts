import {anyDurationShape} from 'date-vir';
import {defineShape, enumShape, nullableShape, recordShape} from 'object-shape-tester';
import {botAiShape} from './bot-ai.js';

/**
 * How a bot run ended.
 *
 * @category Internal
 */
export enum BotRunResult {
    /** The run reported something or ran AI. */
    Succeeded = 'succeeded',
    /** The run neither reported anything nor ran AI. */
    NothingToDo = 'nothingToDo',
    Failed = 'failed',
}

/**
 * Where an AI run that Agent Storm hosts stands.
 *
 * @category Internal
 */
export enum BotAiRunStatus {
    Running = 'running',
    /** Paused on a question or an approval only the user can answer. */
    Waiting = 'waiting',
    Finished = 'finished',
    Failed = 'failed',
}

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
    finishRun: {
        requestShape: defineShape({
            result: enumShape(BotRunResult),
            error: nullableShape(''),
        }),
        responseShape: defineShape({}),
    },
    /** Starts the run's AI work as a thread in the bot's AI Chat tab. */
    startAi: {
        requestShape: defineShape({
            text: '',
            ai: botAiShape,
            env: environmentShape,
        }),
        responseShape: defineShape({
            threadId: '',
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
        }),
        responseShape: defineShape({
            threadId: '',
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
        {
            name: '',
            description: '',
            interval: anyDurationShape,
            ai: nullableShape(botAiShape),
            /** Why the bot's definition failed to load. The other fields are then blank. */
            error: nullableShape(''),
        },
    ],
});

/**
 * The output of `agent-storm-bot --list`.
 *
 * @category Internal
 */
export type BotList = typeof botListShape.runtimeType;
