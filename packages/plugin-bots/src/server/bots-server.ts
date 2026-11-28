import {BotAiEffort, BotAiProvider, type BotAi} from '@agent-storm/bot/src/bot-ai.js';
import {
    agentStormRunFlag,
    BotAiRunStatus,
    botCliCommand,
    BotRunResult,
    type BotList,
    type BotRunFile,
    type EndedBotAiRunStatus,
} from '@agent-storm/bot/src/protocol.js';
import {
    AiProvider,
    buildExportsKey,
    PaneKind,
    ReasoningEffort,
    RuntimeMode,
    ThreadOrigin,
    ThreadStatus,
    type BuildServerExports,
} from '@agent-storm/common';
import {definePluginServer, type PluginCallHandlers} from '@agent-storm/core/server';
import {usageExportsKey} from '@agent-storm/plugin-usage/src/usage-exports.js';
import {assertWrap, check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getObjectTypedEntries,
    log,
    omitObjectKeys,
    shellQuote,
} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {
    BotConfigApproval,
    BotRunStatus,
    BotRunTrigger,
    botsApi,
    botsPluginId,
    BotState,
    toBotScope,
    type BotQuestion,
    type BotRun,
    type BotSettings,
} from '../bots-api.js';
import {BotsNotificationName, botsNotificationTypes} from '../notification-types.js';
import {startBotCallServer, type BotCallHandlers} from './bot-call-server.js';
import {createBotId, createRepoId, listRepoBots, readRepoConfig} from './bot-discovery.js';
import {
    findAiRunStop,
    findSpendBreach,
    isAiRunTimedOut,
    readBotLimits,
} from './bot-limits-check.js';
import {
    createBotsStorage,
    type StoredAiThreads,
    type StoredApiKeys,
    type StoredBots,
} from './bots-storage.js';

const defaultBotSettings: Readonly<BotSettings> = {
    isEnabled: false,
    interval: undefined,
    ai: undefined,
    runtimeMode: RuntimeMode.Auto,
    limits: undefined,
};

/** How many lines one run's history entry keeps, so a chatty bot can't grow its file forever. */
const maxReportsPerRun = 500;

const runStatusFromResult: Readonly<Record<BotRunResult, BotRunStatus>> = {
    [BotRunResult.Succeeded]: BotRunStatus.Succeeded,
    [BotRunResult.NothingToDo]: BotRunStatus.NothingToDo,
    [BotRunResult.Failed]: BotRunStatus.Failed,
};

const isFailedRunStatus: Readonly<Record<BotRunStatus, boolean>> = {
    [BotRunStatus.Running]: false,
    [BotRunStatus.Succeeded]: false,
    [BotRunStatus.NothingToDo]: false,
    [BotRunStatus.Failed]: true,
    [BotRunStatus.Interrupted]: true,
};

const buildProviders: Readonly<Record<BotAiProvider, AiProvider>> = {
    [BotAiProvider.Claude]: AiProvider.Claude,
    [BotAiProvider.Codex]: AiProvider.Codex,
};

const buildEfforts: Readonly<Record<BotAiEffort, ReasoningEffort>> = {
    [BotAiEffort.Low]: ReasoningEffort.Low,
    [BotAiEffort.Medium]: ReasoningEffort.Medium,
    [BotAiEffort.High]: ReasoningEffort.High,
    [BotAiEffort.XHigh]: ReasoningEffort.ExtraHigh,
    [BotAiEffort.Max]: ReasoningEffort.Max,
    [BotAiEffort.Ultra]: ReasoningEffort.Ultra,
};

const aiRunStatuses: Readonly<Record<ThreadStatus, BotAiRunStatus>> = {
    [ThreadStatus.Idle]: BotAiRunStatus.Finished,
    [ThreadStatus.Running]: BotAiRunStatus.Running,
    [ThreadStatus.NeedsApproval]: BotAiRunStatus.Waiting,
    [ThreadStatus.Failed]: BotAiRunStatus.Failed,
};

const isThreadTurnGoing: Readonly<Record<ThreadStatus, boolean>> = {
    [ThreadStatus.Idle]: false,
    [ThreadStatus.Running]: true,
    [ThreadStatus.NeedsApproval]: true,
    [ThreadStatus.Failed]: false,
};

type KnownBot = Readonly<{
    botId: string;
    entry: Readonly<BotList['bots'][number]>;
}>;

type KnownRepo = Readonly<{
    repoId: string;
    repoPath: string;
    configPath: string;
    /** Of the config file and the bot files it names. Empty when it couldn't be read. */
    hash: string;
    listError: string | undefined;
    bots: ReadonlyArray<KnownBot>;
}>;

type ActiveRun = {
    runId: string;
    botId: string;
    token: string;
    /** As it was when the run started, so a config edited mid-run can't strand the run. */
    repoPath: string;
    /**
     * As the run reported it, else as it was when the run started, so a config edited mid-run can't
     * strand the run.
     */
    entry: KnownBot['entry'];
    /** The Shell tab the run's command was typed into, once it was. */
    shellSessionId: string | undefined;
    /** Epoch milliseconds of the run's last call, or of typing its command before its first. */
    heardAt: number;
    /** Whether the run has called Agent Storm yet. */
    isHeard: boolean;
};

type PendingQuestion = Readonly<
    BotQuestion & {
        runId: string;
    }
>;

type GivenAnswer = Readonly<{
    questionId: string;
    runId: string;
    answer: string | undefined;
}>;

export default definePluginServer({
    api: botsApi,
    async start({emit, dataDir, tempDir, host, waitForPlugin}) {
        const storage = createBotsStorage(dataDir);
        const [
            storedBots,
            storedApiKeys,
            storedRuns,
            storedAiThreads,
        ] = await Promise.all([
            storage.readBots(),
            storage.readApiKeys(),
            storage.readAllRuns(),
            storage.readAiThreads(),
        ]);

        const state: {
            stored: StoredBots;
            apiKeys: StoredApiKeys;
            /** Newest first, by bot id. */
            runs: Map<string, BotRun[]>;
            aiThreads: StoredAiThreads['threads'];
            /** The AI runs Agent Storm stopped at a limit, by thread id, with why. */
            stoppedAiThreads: Map<string, EndedBotAiRunStatus>;
            repos: ReadonlyArray<KnownRepo>;
            /** Each repo's latest `listRepoBots` result, by repo path. */
            lists: Map<
                string,
                Readonly<{
                    hash: string;
                    /** Epoch milliseconds. */
                    listedAt: number;
                    list: BotList | undefined;
                    error: string | undefined;
                }>
            >;
            /** Pending run history writes, by bot id. */
            runWriteTimers: Map<string, ReturnType<typeof setTimeout>>;
            /** Epoch milliseconds of the last schedule pass. */
            lastScheduleAt: number;
            activeRuns: ActiveRun[];
            questions: PendingQuestion[];
            answers: GivenAnswer[];
            /** The discovery in progress, which the next one waits for. */
            discovery: Promise<void>;
            /** Each bot's shell lookup in progress, so two at once don't make two tabs. */
            shellLookups: Map<
                string,
                Promise<Readonly<{folder: string; scope: string; sessionId: string}>>
            >;
            isStopped: boolean;
            /** Removes the API key reader from the Build that last got it. */
            unregisterThreadOwner: (() => void) | undefined;
        } = {
            stored: storedBots,
            apiKeys: storedApiKeys,
            runs: storedRuns,
            aiThreads: storedAiThreads.threads,
            stoppedAiThreads: new Map(),
            repos: [],
            lists: new Map(),
            runWriteTimers: new Map(),
            lastScheduleAt: Date.now(),
            activeRuns: [],
            questions: [],
            answers: [],
            discovery: Promise.resolve(),
            shellLookups: new Map(),
            isStopped: false,
            unregisterThreadOwner: undefined,
        };

        /** A run still marked running belongs to an app that stopped before it ended. */
        await Promise.all(
            [...state.runs.entries()].map(
                async ([
                    botId,
                    runs,
                ]) => {
                    if (!runs.some((run) => run.status === BotRunStatus.Running)) {
                        return;
                    }
                    const updated = runs.map((run) => {
                        return run.status === BotRunStatus.Running
                            ? {
                                  ...run,
                                  status: BotRunStatus.Interrupted,
                                  endedAt: run.endedAt ?? Date.now(),
                                  error:
                                      run.error || 'Agent Storm stopped while the run was going.',
                              }
                            : run;
                    });
                    state.runs.set(botId, updated);
                    await storage.writeRuns({
                        botId,
                        runs: updated,
                    });
                },
            ),
        );

        function emitStateChanged() {
            if (!state.isStopped) {
                emit('stateChanged', {});
            }
        }

        function findBot(botId: string) {
            return state.repos
                .map((repo) => {
                    const bot = repo.bots.find((known) => known.botId === botId);
                    return bot
                        ? {
                              repo,
                              bot,
                          }
                        : undefined;
                })
                .find(check.isDefined);
        }

        function requireBot(botId: string) {
            return assertWrap.isDefined(
                findBot(botId),
                'That bot is no longer in its repo config.',
            );
        }

        function requireRepo(repoPath: string) {
            return assertWrap.isDefined(
                state.repos.find((known) => known.repoPath === repoPath),
                'That repo has no bots in a .agent-storm/agent-storm.config file.',
            );
        }

        function readSettings(botId: string) {
            return (
                state.stored.bots.find((stored) => stored.botId === botId)?.settings ||
                defaultBotSettings
            );
        }

        function readLimits(run: Readonly<ActiveRun>) {
            return readBotLimits({
                overrides: readSettings(run.botId).limits,
                defaults: run.entry.limits,
            });
        }

        /** Why the bot's spend limit keeps it from running more AI, if it does. */
        async function findSpendLimitBreach(run: Readonly<ActiveRun>) {
            const maxSpendPerDayUsd = readLimits(run).maxSpendPerDayUsd;
            if (maxSpendPerDayUsd == undefined) {
                return undefined;
            }
            const usage = await waitForPlugin(usageExportsKey);
            const cost = await usage?.readThreadsCost({
                threadIds: [
                    ...state.aiThreads
                        .filter((thread) => thread.botId === run.botId)
                        .map((thread) => thread.threadId),
                    ...(state.runs.get(run.botId) || []).flatMap(
                        (stored) => stored.startedThreadIds,
                    ),
                ],
                since:
                    Date.now() -
                    convertDuration(
                        {
                            hours: 24,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds,
            });
            return findSpendBreach({
                maxSpendPerDayUsd,
                cost,
            });
        }

        function readApiKey(botId: string) {
            return state.apiKeys.keys.find((key) => key.botId === botId)?.apiKey;
        }

        function readApproval({repoPath, hash}: Readonly<{repoPath: string; hash: string}>) {
            const approval = state.stored.approvals.find((stored) => stored.repoPath === repoPath);
            if (!approval) {
                return BotConfigApproval.Unapproved;
            }
            return approval.hash === hash ? BotConfigApproval.Approved : BotConfigApproval.Changed;
        }

        function findActiveRun(botId: string) {
            return state.activeRuns.find((run) => run.botId === botId);
        }

        function findNextRunAt({repo, bot}: Readonly<{repo: KnownRepo; bot: KnownBot}>) {
            const settings = readSettings(bot.botId);
            if (
                !settings.isEnabled ||
                bot.entry.error ||
                findActiveRun(bot.botId) ||
                readApproval(repo) !== BotConfigApproval.Approved
            ) {
                return undefined;
            }
            const runs = state.runs.get(bot.botId) || [];
            const lastRun = runs[0];
            if (!lastRun) {
                return Date.now();
            }
            const interval = convertDuration(settings.interval || bot.entry.interval, {
                milliseconds: true,
            }).milliseconds;
            const succeededIndex = runs.findIndex((run) => !isFailedRunStatus[run.status]);
            const failureCount = succeededIndex === -1 ? runs.length : succeededIndex;
            /**
             * Each failure in a row doubles the wait, so a broken bot doesn't notify every
             * interval.
             */
            const backoff = Math.min(
                interval * 2 ** Math.max(failureCount - 1, 0),
                convertDuration(
                    {
                        hours: 6,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            );
            return lastRun.startedAt + Math.max(interval, backoff);
        }

        function findBotState(botId: string) {
            const lastRun = state.runs.get(botId)?.[0];
            if (state.questions.some((question) => question.botId === botId)) {
                return BotState.Waiting;
            } else if (findActiveRun(botId)) {
                return BotState.Running;
            } else if (!readSettings(botId).isEnabled) {
                return BotState.Off;
            } else if (lastRun && isFailedRunStatus[lastRun.status]) {
                return BotState.Failed;
            } else {
                return BotState.Idle;
            }
        }

        function toBotInfo({repo, bot}: Readonly<{repo: KnownRepo; bot: KnownBot}>) {
            return {
                botId: bot.botId,
                name: bot.entry.name,
                description: bot.entry.description,
                defaultInterval: bot.entry.interval,
                defaultAi: bot.entry.ai || undefined,
                defaultLimits: bot.entry.limits || undefined,
                loadError: bot.entry.error || undefined,
                settings: readSettings(bot.botId),
                hasApiKey: !!readApiKey(bot.botId),
                state: findBotState(bot.botId),
                nextRunAt: findNextRunAt({
                    repo,
                    bot,
                }),
                lastRun: state.runs.get(bot.botId)?.[0],
                aiThreadId: state.aiThreads.findLast((stored) => stored.botId === bot.botId)
                    ?.threadId,
            };
        }

        async function readRepo(repoPath: string, isForced: boolean) {
            const base = {
                repoId: createRepoId(repoPath),
                repoPath,
            };
            try {
                const config = await readRepoConfig(repoPath);
                if (!config) {
                    return undefined;
                }
                const repo = {
                    ...base,
                    configPath: config.configPath,
                    hash: config.hash,
                };
                if (readApproval(repo) !== BotConfigApproval.Approved) {
                    return {
                        ...repo,
                        listError: undefined,
                        bots: [],
                    };
                }
                const cached = state.lists.get(repoPath);
                /**
                 * A failed list is retried less often than discovery runs, since each try spawns
                 * Node.
                 */
                const listed =
                    cached &&
                    !isForced &&
                    cached.hash === config.hash &&
                    (cached.list ||
                        Date.now() - cached.listedAt <
                            convertDuration(
                                {
                                    minutes: 10,
                                },
                                {
                                    milliseconds: true,
                                },
                            ).milliseconds)
                        ? cached
                        : await listRepoBots(repoPath).then(
                              (list) => {
                                  return {
                                      hash: config.hash,
                                      listedAt: Date.now(),
                                      list,
                                      error: undefined,
                                  };
                              },
                              (error: unknown) => {
                                  return {
                                      hash: config.hash,
                                      listedAt: Date.now(),
                                      list: undefined,
                                      error: [
                                          "Couldn't list the repo's bots. Is @agent-storm/bot installed at the repo root?",
                                          extractErrorMessage(error),
                                      ].join(' '),
                                  };
                              },
                          );
                state.lists.set(repoPath, listed);
                return {
                    ...repo,
                    listError: listed.error,
                    bots:
                        listed.list?.bots.map((entry) => {
                            return {
                                botId: createBotId({
                                    repoPath,
                                    name: entry.name,
                                }),
                                entry,
                            };
                        }) || [],
                };
            } catch (error) {
                return {
                    ...base,
                    configPath: '',
                    hash: '',
                    listError: extractErrorMessage(error),
                    bots: [],
                };
            }
        }

        async function discover(isForced: boolean) {
            const repoPaths = (await host.listFolders())
                .filter((folder) => !folder.parentRepoPath)
                .map((folder) => folder.path);
            const repos = await Promise.all(
                repoPaths.map(async (repoPath) => await readRepo(repoPath, isForced)),
            );
            state.repos = repos.filter(check.isDefined);
            emitStateChanged();
            await pruneLeftovers();
        }

        /**
         * Forgets bots their config no longer lists. Only repos whose bots were just listed count,
         * since a repo missing from the sidebar, unapproved, or failing to list says nothing about
         * which bots it still has.
         */
        async function pruneLeftovers() {
            const listedRepos = state.repos.filter((repo) => {
                return readApproval(repo) === BotConfigApproval.Approved && !repo.listError;
            });
            const listedBots = listedRepos.flatMap((repo) => {
                return repo.bots.map((bot) => {
                    return {
                        botId: bot.botId,
                        repoPath: repo.repoPath,
                    };
                });
            });
            const knownBots = state.stored.knownBots || [];
            const goneBotIds = knownBots
                .filter((known) => {
                    return (
                        listedRepos.some((repo) => repo.repoPath === known.repoPath) &&
                        !listedBots.some((listed) => listed.botId === known.botId) &&
                        !findActiveRun(known.botId)
                    );
                })
                .map((known) => known.botId);
            const newBots = listedBots.filter((listed) => {
                return !knownBots.some((known) => known.botId === listed.botId);
            });
            if (!goneBotIds.length && !newBots.length) {
                return;
            }
            await saveStoredBots({
                ...state.stored,
                bots: state.stored.bots.filter((stored) => !goneBotIds.includes(stored.botId)),
                knownBots: [
                    ...knownBots.filter((known) => !goneBotIds.includes(known.botId)),
                    ...newBots,
                ],
            });
            if (!goneBotIds.length) {
                return;
            }
            state.apiKeys = {
                keys: state.apiKeys.keys.filter((key) => !goneBotIds.includes(key.botId)),
            };
            state.aiThreads = state.aiThreads.filter(
                (thread) => !goneBotIds.includes(thread.botId),
            );
            goneBotIds.forEach((botId) => {
                clearTimeout(state.runWriteTimers.get(botId));
                state.runWriteTimers.delete(botId);
                state.runs.delete(botId);
            });
            await Promise.all([
                storage.writeApiKeys(state.apiKeys),
                storage.writeAiThreads({
                    threads: state.aiThreads,
                }),
                ...goneBotIds.map(async (botId) => await storage.deleteRuns(botId)),
            ]);
        }

        /** Runs after any discovery in progress, so an older one can't land last. */
        async function queueDiscovery(isForced: boolean) {
            const discovery = state.discovery.then(async () => {
                try {
                    await discover(isForced);
                } catch (error) {
                    log.error(`Bots discovery failed: ${extractErrorMessage(error)}`);
                }
            });
            state.discovery = discovery;
            await discovery;
        }

        async function writeRuns(botId: string) {
            clearTimeout(state.runWriteTimers.get(botId));
            state.runWriteTimers.delete(botId);
            if (!state.isStopped) {
                emit('runsChanged', {
                    botId,
                });
            }
            await storage.writeRuns({
                botId,
                runs: state.runs.get(botId) || [],
            });
        }

        async function saveRuns(botId: string, update: (runs: BotRun[]) => BotRun[]) {
            state.runs.set(botId, update(state.runs.get(botId) || []));
            await writeRuns(botId);
        }

        function changeRun(
            {botId, runId}: Readonly<{botId: string; runId: string}>,
            update: (run: BotRun) => BotRun,
        ) {
            state.runs.set(
                botId,
                (state.runs.get(botId) || []).map((run) => (run.id === runId ? update(run) : run)),
            );
        }

        async function updateRun(
            run: Readonly<{botId: string; runId: string}>,
            update: (run: BotRun) => BotRun,
        ) {
            changeRun(run, update);
            await writeRuns(run.botId);
        }

        /** Saved shortly after, so a bot reporting many lines at once costs one write. */
        function appendReport(run: Readonly<{botId: string; runId: string}>, line: string) {
            changeRun(run, (stored) => {
                return {
                    ...stored,
                    reports: [
                        ...stored.reports,
                        line,
                    ].slice(-maxReportsPerRun),
                };
            });
            if (state.runWriteTimers.has(run.botId)) {
                return;
            }
            state.runWriteTimers.set(
                run.botId,
                setTimeout(
                    async () => {
                        try {
                            await writeRuns(run.botId);
                        } catch (error) {
                            log.error(
                                `Couldn't save a bot's run history: ${extractErrorMessage(error)}`,
                            );
                        }
                    },
                    convertDuration(
                        {
                            seconds: 1,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds,
                ),
            );
        }

        function toRunFilePath(runId: string) {
            return join(tempDir, `${runId}.json`);
        }

        async function saveStoredBots(stored: StoredBots) {
            state.stored = stored;
            emitStateChanged();
            await storage.writeBots(stored);
        }

        async function lookUpBotShell(botId: string) {
            const {repo} = requireBot(botId);
            const scope = toBotScope(botId);
            function findSession(sessions: Awaited<ReturnType<typeof host.getFolderSessions>>) {
                return sessions[PaneKind.Shell].find((session) => session.scope === scope);
            }
            const session =
                findSession(await host.getFolderSessions(repo.repoPath)) ||
                findSession(
                    await host.createFolderSession({
                        folder: repo.repoPath,
                        kind: PaneKind.Shell,
                        scope,
                    }),
                );
            return {
                folder: repo.repoPath,
                scope,
                sessionId: assertWrap.isDefined(session, "Couldn't make the bot's shell tab.").id,
            };
        }

        async function ensureBotShell(botId: string) {
            const pending = state.shellLookups.get(botId) || lookUpBotShell(botId);
            state.shellLookups.set(botId, pending);
            try {
                return await pending;
            } finally {
                state.shellLookups.delete(botId);
            }
        }

        async function finishRun({
            runId,
            status,
            error,
        }: Readonly<{
            runId: string;
            status: BotRunStatus;
            error: string | undefined;
        }>) {
            const activeRun = state.activeRuns.find((run) => run.runId === runId);
            if (!activeRun) {
                return;
            }
            state.activeRuns = state.activeRuns.filter((run) => run.runId !== runId);
            state.questions = state.questions.filter((question) => question.runId !== runId);
            state.answers = state.answers.filter((answer) => answer.runId !== runId);
            state.runs
                .get(activeRun.botId)
                ?.find((run) => run.id === runId)
                ?.aiThreadIds.forEach((threadId) => {
                    state.stoppedAiThreads.delete(threadId);
                });
            await updateRun(activeRun, (run) => {
                return {
                    ...run,
                    status,
                    endedAt: Date.now(),
                    error,
                };
            });
            emitStateChanged();
            /** The CLI deletes it once read, so it is only left when the command never started. */
            await rm(toRunFilePath(runId), {
                force: true,
            });
            if (isFailedRunStatus[status]) {
                await host.notify({
                    type: botsNotificationTypes[BotsNotificationName.RunFailed],
                    title: `The ${activeRun.entry.name} bot failed`,
                    body: error || 'The run failed.',
                    paths: [
                        botsPluginId,
                        activeRun.botId,
                    ],
                    folder: activeRun.repoPath,
                });
            }
        }

        async function startRun({
            botId,
            trigger,
        }: Readonly<{botId: string; trigger: BotRunTrigger}>) {
            const {repo, bot} = requireBot(botId);
            if (findActiveRun(botId)) {
                throw new Error('The bot is already running.');
            }
            const runId = randomUUID();
            const now = Date.now();
            const activeRun: ActiveRun = {
                runId,
                botId,
                token: randomBytes(32).toString('hex'),
                repoPath: repo.repoPath,
                entry: bot.entry,
                shellSessionId: undefined,
                heardAt: now,
                isHeard: false,
            };
            state.activeRuns = [
                ...state.activeRuns,
                activeRun,
            ];
            await saveRuns(botId, (runs) => {
                return [
                    {
                        id: runId,
                        botId,
                        trigger,
                        status: BotRunStatus.Running,
                        startedAt: now,
                        endedAt: undefined,
                        reports: [],
                        aiThreadIds: [],
                        startedThreadIds: [],
                        error: undefined,
                    },
                    ...runs,
                ];
            });
            emitStateChanged();
            try {
                /**
                 * Approval covers the config and the bot files it names by path, not what those
                 * import, and any of them may have changed since.
                 */
                const config = await readRepoConfig(repo.repoPath);
                if (
                    !config ||
                    readApproval({
                        repoPath: repo.repoPath,
                        hash: config.hash,
                    }) !== BotConfigApproval.Approved
                ) {
                    await queueDiscovery(false);
                    throw new Error(
                        'The .agent-storm/agent-storm.config file or a bot file it names changed since you approved it. Approve it again in the Bots tab.',
                    );
                }
                const shell = await ensureBotShell(botId);
                if (
                    await host.isPaneRunningCommand({
                        folder: shell.folder,
                        kind: PaneKind.Shell,
                        sessionId: shell.sessionId,
                    })
                ) {
                    throw new Error(
                        "The bot's Shell tab is still running something. Stop it there, then run the bot again.",
                    );
                }
                const runFilePath = toRunFilePath(runId);
                await writeFileAtomically({
                    path: runFilePath,
                    contents: JSON.stringify({
                        url: callServer.url,
                        token: activeRun.token,
                        runId,
                        ai: readSettings(botId).ai,
                    } satisfies BotRunFile),
                    mode: 0o600,
                });
                activeRun.shellSessionId = shell.sessionId;
                activeRun.heardAt = Date.now();
                await host.sendPaneText({
                    folder: shell.folder,
                    kind: PaneKind.Shell,
                    sessionId: shell.sessionId,
                    text: [
                        'cd',
                        shellQuote(shell.folder),
                        '&&',
                        botCliCommand,
                        `--${agentStormRunFlag}`,
                        shellQuote(runFilePath),
                        shellQuote(bot.entry.name),
                    ].join(' '),
                });
            } catch (error) {
                await finishRun({
                    runId,
                    status: BotRunStatus.Failed,
                    error: `Couldn't start the run: ${extractErrorMessage(error)}`,
                });
            }
        }

        async function requireBuild() {
            return assertWrap.isDefined(
                await waitForPlugin(buildExportsKey),
                'Turn on Build for bots to run AI.',
            );
        }

        /** Starts a Build thread in the run's repo, on the run's model and its bot's settings. */
        async function startRunThread({
            run,
            ai,
            ...params
        }: Readonly<
            Pick<
                Parameters<BuildServerExports['startPluginThread']>[0],
                | 'origin'
                | 'text'
                | 'isInWorktree'
                | 'env'
                | 'title'
                | 'workingDirectory'
                | 'isUnattended'
            > & {
                run: Readonly<ActiveRun>;
                ai: Readonly<BotAi>;
            }
        >) {
            return await (
                await requireBuild()
            ).startPluginThread({
                ...params,
                cwd: run.repoPath,
                provider: buildProviders[ai.provider],
                model: ai.model,
                effort: ai.effort ? buildEfforts[ai.effort] : undefined,
                runtimeMode: readSettings(run.botId).runtimeMode,
                pluginId: botsPluginId,
                ownerId: run.botId,
            });
        }

        async function registerThreadOwner() {
            state.unregisterThreadOwner = (
                await waitForPlugin(buildExportsKey)
            )?.registerThreadOwner({
                pluginId: botsPluginId,
                readApiKey,
            });
        }

        /** Stops each run's AI turn that went past its bot's time or spend limit. */
        async function enforceAiLimits() {
            const build = await waitForPlugin(buildExportsKey);
            if (!build) {
                return;
            }
            await Promise.all(
                state.activeRuns.map(async (run) => {
                    const threadId = state.runs
                        .get(run.botId)
                        ?.find((stored) => stored.id === run.runId)
                        ?.aiThreadIds.at(-1);
                    if (!threadId || state.stoppedAiThreads.has(threadId)) {
                        return;
                    }
                    const thread = await build.readPluginThread(threadId);
                    if (!thread || !isThreadTurnGoing[thread.status]) {
                        return;
                    }
                    const isTimedOut = isAiRunTimedOut({
                        maxAiRunDuration: readLimits(run).maxAiRunDuration,
                        startedAt: state.aiThreads.findLast(
                            (stored) => stored.threadId === threadId,
                        )?.startedAt,
                        now: Date.now(),
                    });
                    const stop = findAiRunStop({
                        isTimedOut,
                        spendBreach: isTimedOut ? undefined : await findSpendLimitBreach(run),
                    });
                    if (!stop) {
                        return;
                    }
                    state.stoppedAiThreads.set(threadId, stop.status);
                    appendReport(run, stop.reason);
                    await build.interruptPluginThread(threadId);
                }),
            );
        }

        /** Why the run is over though it never said so, if it is. */
        async function findRunEnding(run: Readonly<ActiveRun>, now: number) {
            const quietFor = now - run.heardAt;
            /**
             * A running CLI calls in more often than every 30 seconds, so a quieter one may have
             * exited. Windows can't tell whether the shell runs a command, so there only the quiet
             * limits below apply.
             */
            const hasShellExited =
                process.platform !== 'win32' &&
                !!run.shellSessionId &&
                quietFor >
                    convertDuration(
                        {
                            seconds: 30,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds &&
                !(await host
                    .isPaneRunningCommand({
                        folder: run.repoPath,
                        kind: PaneKind.Shell,
                        sessionId: run.shellSessionId,
                    })
                    .catch(() => true));
            if (hasShellExited) {
                return run.isHeard
                    ? {
                          status: BotRunStatus.Interrupted,
                          error: "The bot's command ended before it finished its run. Its Shell tab shows why.",
                      }
                    : {
                          status: BotRunStatus.Failed,
                          error: "The bot's command exited before it reached Agent Storm. Its Shell tab shows why.",
                      };
            }
            /** Before its first call the command may still be installing or compiling. */
            const maxQuiet = convertDuration(
                run.isHeard
                    ? {
                          minutes: 2,
                      }
                    : {
                          minutes: 10,
                      },
                {
                    milliseconds: true,
                },
            ).milliseconds;
            if (quietFor <= maxQuiet) {
                return undefined;
            }
            return {
                status: BotRunStatus.Interrupted,
                error: run.isHeard
                    ? 'Agent Storm stopped hearing from the run.'
                    : "The bot's command didn't reach Agent Storm in time.",
            };
        }

        async function runSchedule() {
            /** A restarted Build has forgotten the reader. */
            await registerThreadOwner();
            const now = Date.now();
            /**
             * A long gap since the last pass means the computer slept or the app stalled, which
             * paused the runs' calls too.
             */
            if (
                now - state.lastScheduleAt >
                convertDuration(
                    {
                        minutes: 1,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds
            ) {
                state.activeRuns.forEach((run) => {
                    run.heardAt = now;
                });
            }
            state.lastScheduleAt = now;
            await Promise.all(
                state.activeRuns.map(async (run) => {
                    const ending = await findRunEnding(run, now);
                    if (ending) {
                        await finishRun({
                            runId: run.runId,
                            ...ending,
                        });
                    }
                }),
            );
            await enforceAiLimits();
            const dueBots = state.repos.flatMap((repo) => {
                return repo.bots.filter((bot) => {
                    const nextRunAt = findNextRunAt({
                        repo,
                        bot,
                    });
                    return nextRunAt != undefined && nextRunAt <= now;
                });
            });
            await Promise.all(
                dueBots.map(async (bot) => {
                    await startRun({
                        botId: bot.botId,
                        trigger: BotRunTrigger.Schedule,
                    });
                }),
            );
        }

        const runHandlers: BotCallHandlers<ActiveRun> = {
            heartbeat() {
                return {};
            },
            report({run, request}) {
                appendReport(run, request.line);
                return {};
            },
            reportDefinition({run, request}) {
                const entry = {
                    ...request,
                    name: run.entry.name,
                    error: undefined,
                };
                run.entry = entry;
                const cached = state.lists.get(run.repoPath);
                if (cached?.list) {
                    state.lists.set(run.repoPath, {
                        ...cached,
                        list: {
                            bots: cached.list.bots.map((listed) => {
                                return listed.name === entry.name ? entry : listed;
                            }),
                        },
                    });
                }
                state.repos = state.repos.map((repo) => {
                    return repo.repoPath === run.repoPath
                        ? {
                              ...repo,
                              bots: repo.bots.map((bot) => {
                                  return bot.botId === run.botId
                                      ? {
                                            ...bot,
                                            entry,
                                        }
                                      : bot;
                              }),
                          }
                        : repo;
                });
                emitStateChanged();
                return {};
            },
            async finishRun({run, request}) {
                await finishRun({
                    runId: run.runId,
                    status: runStatusFromResult[request.result],
                    error: request.error || undefined,
                });
                return {};
            },
            async startAi({run, request}) {
                const spendBreach = await findSpendLimitBreach(run);
                if (spendBreach) {
                    appendReport(run, `${spendBreach} The AI run didn't start.`);
                    return {
                        threadId: undefined,
                    };
                }
                const build = await requireBuild();
                const launchKey = createHash('sha256')
                    .update(
                        JSON.stringify({
                            provider: request.ai.provider,
                            cwd: request.cwd || '',
                            env: getObjectTypedEntries(request.env).toSorted(
                                ([firstKey], [secondKey]) => firstKey.localeCompare(secondKey),
                            ),
                        }),
                    )
                    .digest('hex');
                const latest = state.aiThreads.findLast((stored) => stored.botId === run.botId);
                const botThread =
                    latest?.launchKey === launchKey
                        ? await build.readPluginThread(latest.threadId)
                        : undefined;
                if (botThread && isThreadTurnGoing[botThread.status]) {
                    throw new Error(
                        "The bot's AI Chat tab is still busy with an earlier message, so the AI run didn't start.",
                    );
                }
                const thread =
                    (botThread &&
                        (await build.continuePluginThread({
                            threadId: botThread.id,
                            text: request.text,
                            model: request.ai.model,
                            effort: request.ai.effort ? buildEfforts[request.ai.effort] : undefined,
                            runtimeMode: readSettings(run.botId).runtimeMode,
                            isUnattended: !!request.isUnattended,
                        }))) ||
                    (await startRunThread({
                        run,
                        ai: request.ai,
                        origin: ThreadOrigin.Bot,
                        text: request.text,
                        isInWorktree: false,
                        env: request.env,
                        title: `${run.entry.name} bot`,
                        workingDirectory: request.cwd || undefined,
                        isUnattended: !!request.isUnattended,
                    }));
                state.stoppedAiThreads.delete(thread.id);
                const now = Date.now();
                /**
                 * Older messages are out of every limit's window. Each bot's latest one stays,
                 * since it names the bot's thread.
                 */
                state.aiThreads = [
                    ...state.aiThreads.filter((stored, index) => {
                        return (
                            now - stored.startedAt <
                                convertDuration(
                                    {
                                        days: 2,
                                    },
                                    {
                                        milliseconds: true,
                                    },
                                ).milliseconds ||
                            !state.aiThreads
                                .slice(index + 1)
                                .some((later) => later.botId === stored.botId)
                        );
                    }),
                    {
                        botId: run.botId,
                        threadId: thread.id,
                        startedAt: now,
                        launchKey,
                    },
                ];
                await storage.writeAiThreads({
                    threads: state.aiThreads,
                });
                await updateRun(run, (stored) => {
                    return {
                        ...stored,
                        aiThreadIds: stored.aiThreadIds.includes(thread.id)
                            ? stored.aiThreadIds
                            : [
                                  ...stored.aiThreadIds,
                                  thread.id,
                              ],
                    };
                });
                emitStateChanged();
                return {
                    threadId: thread.id,
                };
            },
            async readAi({run, request}) {
                const isRunThread = state.runs
                    .get(run.botId)
                    ?.find((stored) => stored.id === run.runId)
                    ?.aiThreadIds.includes(request.threadId);
                if (!isRunThread) {
                    throw new Error('That AI run belongs to another bot run.');
                }
                const thread = await (await requireBuild()).readPluginThread(request.threadId);
                const stoppedStatus = state.stoppedAiThreads.get(request.threadId);
                if (!thread) {
                    return {
                        status: BotAiRunStatus.Failed,
                    };
                }
                return {
                    status:
                        stoppedStatus && !isThreadTurnGoing[thread.status]
                            ? stoppedStatus
                            : aiRunStatuses[thread.status],
                };
            },
            async askQuestion({run, request}) {
                const questionId = randomUUID();
                state.questions = [
                    ...state.questions,
                    {
                        ...request,
                        questionId,
                        botId: run.botId,
                        runId: run.runId,
                        askedAt: Date.now(),
                    },
                ];
                emitStateChanged();
                await host.notify({
                    type: botsNotificationTypes[BotsNotificationName.Question],
                    title: `The ${run.entry.name} bot asks`,
                    body: request.question,
                    paths: [
                        botsPluginId,
                        run.botId,
                    ],
                    folder: run.repoPath,
                });
                return {
                    questionId,
                };
            },
            readAnswer({run, request}) {
                const given = state.answers.find((answer) => {
                    return answer.questionId === request.questionId && answer.runId === run.runId;
                });
                if (given) {
                    state.answers = state.answers.filter((answer) => answer !== given);
                    return {
                        isPending: false,
                        answer: given.answer,
                    };
                }
                return {
                    isPending: state.questions.some((question) => {
                        return (
                            question.questionId === request.questionId &&
                            question.runId === run.runId
                        );
                    }),
                    answer: undefined,
                };
            },
            async startThread({run, request}) {
                const spendBreach = await findSpendLimitBreach(run);
                if (spendBreach) {
                    appendReport(run, `${spendBreach} The thread didn't start.`);
                    return {
                        threadId: undefined,
                    };
                }
                const thread = await startRunThread({
                    run,
                    ai: request.ai,
                    origin: ThreadOrigin.User,
                    text: request.text,
                    isInWorktree: request.isInWorktree,
                    env: request.env || {},
                    title: request.title || undefined,
                    workingDirectory: request.cwd || undefined,
                    isUnattended: !!request.isUnattended,
                });
                await updateRun(run, (stored) => {
                    return {
                        ...stored,
                        startedThreadIds: [
                            ...stored.startedThreadIds,
                            thread.id,
                        ],
                    };
                });
                return {
                    threadId: thread.id,
                };
            },
            async readLastUserInput() {
                return {
                    lastUserInputAt: await host.readLastUserInputAt(),
                };
            },
            async createWorktree({run, request}) {
                return await host.createWorktree({
                    folder: run.repoPath,
                    name: request.name,
                    scope: toBotScope(run.botId),
                });
            },
            async notify({run, request}) {
                await host.notify({
                    type: botsNotificationTypes[BotsNotificationName.Message],
                    title: request.title,
                    body: request.body,
                    paths: [
                        botsPluginId,
                        run.botId,
                    ],
                    folder: run.repoPath,
                });
                return {};
            },
        };

        const callServer = await startBotCallServer({
            findRun(token) {
                const run = state.activeRuns.find((active) => active.token === token);
                if (run) {
                    run.heardAt = Date.now();
                    run.isHeard = true;
                }
                return run;
            },
            handlers: runHandlers,
        });

        /** Clears the key when `apiKey` is undefined. */
        async function saveApiKey({
            botId,
            apiKey,
        }: Readonly<{
            botId: string;
            apiKey: string | undefined;
        }>) {
            state.apiKeys = {
                keys: [
                    ...state.apiKeys.keys.filter((key) => key.botId !== botId),
                    ...(apiKey
                        ? [
                              {
                                  botId,
                                  apiKey,
                              },
                          ]
                        : []),
                ],
            };
            emitStateChanged();
            await storage.writeApiKeys(state.apiKeys);
        }

        const calls: PluginCallHandlers<typeof botsApi> = {
            readState() {
                return {
                    repos: state.repos.map((repo) => {
                        return {
                            repoId: repo.repoId,
                            repoPath: repo.repoPath,
                            name: basename(repo.repoPath),
                            configPath: repo.configPath,
                            approval: readApproval(repo),
                            listError: repo.listError,
                            bots: repo.bots.map((bot) => {
                                return toBotInfo({
                                    repo,
                                    bot,
                                });
                            }),
                        };
                    }),
                    questions: state.questions.map((question) => {
                        return omitObjectKeys(question, [
                            'runId',
                        ]);
                    }),
                };
            },
            async readConfigFile({repoPath}) {
                const config = assertWrap.isDefined(
                    await readRepoConfig(requireRepo(repoPath).repoPath),
                    'The repo no longer has bots in a .agent-storm/agent-storm.config file.',
                );
                return {
                    contents: config.contents,
                    hash: config.hash,
                };
            },
            async approveConfig({repoPath, hash}) {
                const config = await readRepoConfig(requireRepo(repoPath).repoPath);
                if (config?.hash !== hash) {
                    throw new Error(
                        'The config file or a bot file it names changed since you read it. Read it again first.',
                    );
                }
                await saveStoredBots({
                    ...state.stored,
                    approvals: [
                        ...state.stored.approvals.filter((approval) => {
                            return approval.repoPath !== repoPath;
                        }),
                        {
                            repoPath,
                            hash,
                        },
                    ],
                });
                await queueDiscovery(false);
                return {};
            },
            async refresh() {
                await queueDiscovery(true);
                return {};
            },
            async updateBotSettings({botId, settings, apiKey}) {
                requireBot(botId);
                await saveStoredBots({
                    ...state.stored,
                    bots: [
                        ...state.stored.bots.filter((stored) => stored.botId !== botId),
                        {
                            botId,
                            settings,
                        },
                    ],
                });
                if (apiKey) {
                    await saveApiKey({
                        botId,
                        apiKey,
                    });
                }
                return {};
            },
            async setApiKey({botId, apiKey}) {
                requireBot(botId);
                await saveApiKey({
                    botId,
                    apiKey: apiKey || undefined,
                });
                return {};
            },
            async runNow({botId}) {
                const {repo, bot} = requireBot(botId);
                if (readApproval(repo) !== BotConfigApproval.Approved) {
                    throw new Error(
                        "Approve the repo's .agent-storm/agent-storm.config file first.",
                    );
                } else if (bot.entry.error) {
                    throw new Error(`The bot didn't load: ${bot.entry.error}`);
                }
                await startRun({
                    botId,
                    trigger: BotRunTrigger.Manual,
                });
                return {};
            },
            readRuns({botId}) {
                return {
                    runs: state.runs.get(botId) || [],
                };
            },
            answerQuestion({questionId, answer}) {
                const question = assertWrap.isDefined(
                    state.questions.find((pending) => pending.questionId === questionId),
                    'That question was already answered or its run ended.',
                );
                state.questions = state.questions.filter((pending) => pending !== question);
                state.answers = [
                    ...state.answers,
                    {
                        questionId,
                        runId: question.runId,
                        answer: answer || undefined,
                    },
                ];
                emitStateChanged();
                return {};
            },
            async ensureBotShell({botId}) {
                const shell = await ensureBotShell(botId);
                return {
                    folder: shell.folder,
                    scope: shell.scope,
                };
            },
        };

        await registerThreadOwner();
        await queueDiscovery(false);
        const timers = [
            setInterval(
                async () => {
                    await queueDiscovery(false);
                },
                convertDuration(
                    {
                        minutes: 1,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
            setInterval(
                async () => {
                    try {
                        await runSchedule();
                    } catch (error) {
                        log.error(`Bots schedule failed: ${extractErrorMessage(error)}`);
                    }
                },
                convertDuration(
                    {
                        seconds: 15,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        ];

        return {
            calls,
            async stop() {
                await Promise.all(
                    [...state.runWriteTimers.keys()].map(async (botId) => await writeRuns(botId)),
                );
                state.isStopped = true;
                state.unregisterThreadOwner?.();
                timers.forEach((timer) => {
                    clearInterval(timer);
                });
                await callServer.close();
            },
        };
    },
});
