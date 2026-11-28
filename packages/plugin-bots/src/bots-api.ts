import {botAiShape} from '@agent-storm/bot/src/bot-ai.js';
import {botLimitsShape} from '@agent-storm/bot/src/bot-limits.js';
import {botsPluginId, definePluginApi} from '@agent-storm/common';
import {RuntimeMode} from '@agent-storm/plugin-build/src/build-api.js';
import {anyDurationShape} from 'date-vir';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

export {botsPluginId} from '@agent-storm/common';

/** The pane group a bot's shell and AI Chat tabs live in, as `VirPaneGroup`'s `scope`. */
export function toBotScope(botId: string) {
    return `${botsPluginId}:${botId}`;
}

/** The pane group scope of a repo's `agent-storm.config` review, before the repo has bots to show. */
export function toBotsConfigScope(repoId: string) {
    return `${botsPluginId}-config:${repoId}`;
}

/** Whether a pane group's scope is one of the Bots activity's. */
export function isBotsScope(scope: string | undefined) {
    return (
        !!scope &&
        [
            toBotScope(''),
            toBotsConfigScope(''),
        ].some((prefix) => scope.startsWith(prefix))
    );
}

/** The kind of a bots pane group's Bot tab: a bot's controls and history, or a config to approve. */
export const botPaneId = 'bot';

/** What started a bot run. */
export enum BotRunTrigger {
    Schedule = 'schedule',
    /** The Bots tab's Run now. */
    Manual = 'manual',
}

export enum BotRunStatus {
    Running = 'running',
    Succeeded = 'succeeded',
    /** The run didn't report anything, run AI, or ask anything of Agent Storm. */
    NothingToDo = 'nothingToDo',
    Failed = 'failed',
    /** Agent Storm stopped hearing from the run, such as when its shell closed or the app restarted. */
    Interrupted = 'interrupted',
}

/** Whether the user has allowed Agent Storm to run a repo's config file. */
export enum BotConfigApproval {
    Approved = 'approved',
    Unapproved = 'unapproved',
    /** Edited since the user approved it. */
    Changed = 'changed',
}

/** What a bot is doing, as the Bots sidebar shows it. */
export enum BotState {
    Off = 'off',
    Idle = 'idle',
    Running = 'running',
    /** Asked a question the user hasn't answered. */
    Waiting = 'waiting',
    /** Its last run failed or was interrupted. */
    Failed = 'failed',
}

export const botSettingsShape = defineShape({
    isEnabled: false,
    /** Overrides the bot's own interval. */
    interval: nullableShape(anyDurationShape),
    /** Overrides the bot's own model, and any model one of its runs asks for. */
    ai: nullableShape(botAiShape),
    /** How much the bot's AI runs may do without asking. */
    runtimeMode: enumShape(RuntimeMode),
    /** Each limit set here overrides the bot's own. */
    limits: nullableShape(botLimitsShape),
});

export type BotSettings = typeof botSettingsShape.runtimeType;

export const botRunShape = defineShape({
    id: '',
    botId: '',
    trigger: enumShape(BotRunTrigger),
    status: enumShape(BotRunStatus),
    /** Epoch milliseconds. */
    startedAt: 0,
    /** Epoch milliseconds. */
    endedAt: nullableShape(0),
    /** What the bot reported, oldest first. */
    reports: [
        '',
    ],
    /** The Build threads the run's AI work ran in: its bot's thread at the time. */
    aiThreadIds: [
        '',
    ],
    /** The sidebar threads the run started for the user to pick up. */
    startedThreadIds: [
        '',
    ],
    error: nullableShape(''),
});

export type BotRun = typeof botRunShape.runtimeType;

export const botInfoShape = defineShape({
    botId: '',
    name: '',
    description: '',
    /** The bot's own interval, which `settings.interval` overrides. */
    defaultInterval: anyDurationShape,
    /** The bot's own model, which `settings.ai` overrides. */
    defaultAi: nullableShape(botAiShape),
    /** The bot's own limits, which `settings.limits` overrides. */
    defaultLimits: nullableShape(botLimitsShape),
    /** Why the bot's definition failed to load. The bot can't run until it's fixed. */
    loadError: nullableShape(''),
    settings: botSettingsShape,
    hasApiKey: false,
    state: enumShape(BotState),
    /** Epoch milliseconds. Unset while the bot is off or can't run. */
    nextRunAt: nullableShape(0),
    lastRun: nullableShape(botRunShape),
    /** The Build thread the bot's AI works in, which its AI Chat tab shows. */
    aiThreadId: nullableShape(''),
});

export type BotInfo = typeof botInfoShape.runtimeType;

/** A sidebar repo whose `.agent-storm/agent-storm.config` file may list bots. */
export const botRepoShape = defineShape({
    repoId: '',
    repoPath: '',
    name: '',
    configPath: '',
    approval: enumShape(BotConfigApproval),
    /** Why the repo's bots couldn't be listed, such as `@agent-storm/bot` not being installed. */
    listError: nullableShape(''),
    /** Empty until the config is approved. */
    bots: [
        botInfoShape,
    ],
});

export type BotRepo = typeof botRepoShape.runtimeType;

export const botQuestionShape = defineShape({
    questionId: '',
    botId: '',
    question: '',
    options: [
        '',
    ],
    isFreeTextAllowed: false,
    /** Epoch milliseconds. */
    askedAt: 0,
});

export type BotQuestion = typeof botQuestionShape.runtimeType;

export const botsStateShape = defineShape({
    repos: [
        botRepoShape,
    ],
    /** Unanswered, oldest first. */
    questions: [
        botQuestionShape,
    ],
});

export type BotsState = typeof botsStateShape.runtimeType;

export const botsApi = definePluginApi({
    pluginId: botsPluginId,
    calls: {
        readState: {
            requestShape: defineShape({}),
            responseShape: botsStateShape,
        },
        /** The repo's config file as it is now, for the user to read before approving it. */
        readConfigFile: {
            requestShape: defineShape({
                repoPath: '',
            }),
            responseShape: defineShape({
                contents: '',
                hash: '',
            }),
        },
        /** Fails when the file changed since `readConfigFile` gave `hash`. */
        approveConfig: {
            requestShape: defineShape({
                repoPath: '',
                hash: '',
            }),
            responseShape: defineShape({}),
        },
        /** Looks for config files again and lists every approved repo's bots again. */
        refresh: {
            requestShape: defineShape({}),
            responseShape: defineShape({}),
        },
        updateBotSettings: {
            requestShape: defineShape({
                botId: '',
                settings: botSettingsShape,
                /** Replaces the bot's API key when set. `setApiKey` clears it. */
                apiKey: nullableShape(''),
            }),
            responseShape: defineShape({}),
        },
        /** Empty clears the key, so the provider's own login applies again. */
        setApiKey: {
            requestShape: defineShape({
                botId: '',
                apiKey: nullableShape(''),
            }),
            responseShape: defineShape({}),
        },
        runNow: {
            requestShape: defineShape({
                botId: '',
            }),
            responseShape: defineShape({}),
        },
        /** Newest first. */
        readRuns: {
            requestShape: defineShape({
                botId: '',
            }),
            responseShape: defineShape({
                runs: [
                    botRunShape,
                ],
            }),
        },
        /** An empty answer dismisses the question. */
        answerQuestion: {
            requestShape: defineShape({
                questionId: '',
                answer: nullableShape(''),
            }),
            responseShape: defineShape({}),
        },
        /** Makes the shell tab the bot runs in, when it has none, and gives its pane group. */
        ensureBotShell: {
            requestShape: defineShape({
                botId: '',
            }),
            responseShape: defineShape({
                folder: '',
                scope: '',
            }),
        },
    },
    events: {
        /** Something `readState` gives changed. */
        stateChanged: defineShape({}),
        runsChanged: defineShape({
            botId: '',
        }),
    },
});
