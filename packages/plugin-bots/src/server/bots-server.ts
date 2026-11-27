import {BotAiEffort, BotAiProvider, type BotAi} from '@agent-storm/bot/src/bot-ai.js';
import {
    agentStormRunFlag,
    BotAiRunStatus,
    botCliCommand,
    BotRunResult,
    type BotList,
    type BotRunFile,
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
import {assertWrap, check} from '@augment-vir/assert';
import {extractErrorMessage, log, omitObjectKeys, shellQuote} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {randomBytes, randomUUID} from 'node:crypto';
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
import {createBotsStorage, type StoredApiKeys, type StoredBots} from './bots-storage.js';

const defaultBotSettings: Readonly<BotSettings> = {
    isEnabled: false,
    interval: undefined,
    ai: undefined,
    runtimeMode: RuntimeMode.Auto,
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

type KnownBot = Readonly<{
    botId: string;
    entry: Readonly<BotList['bots'][number]>;
}>;

type KnownRepo = Readonly<{
    repoId: string;
    repoPath: string;
    configPath: string;
    /** Of the config file's contents. Empty when it couldn't be read. */
    hash: string;
    listError: string | undefined;
    bots: ReadonlyArray<KnownBot>;
}>;

type ActiveRun = {
    runId: string;
    botId: string;
    token: string;
    /** Epoch milliseconds of the run's last call. */
    heardAt: number;
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
        ] = await Promise.all([
            storage.readBots(),
            storage.readApiKeys(),
            storage.readAllRuns(),
        ]);

        const state: {
            stored: StoredBots;
            apiKeys: StoredApiKeys;
            /** Newest first, by bot id. */
            runs: Map<string, BotRun[]>;
            repos: ReadonlyArray<KnownRepo>;
            /** Successful `listRepoBots` results by repo path and config hash. */
            lists: Map<string, Readonly<{list: BotList}>>;
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
        } = {
            stored: storedBots,
            apiKeys: storedApiKeys,
            runs: storedRuns,
            repos: [],
            lists: new Map(),
            activeRuns: [],
            questions: [],
            answers: [],
            discovery: Promise.resolve(),
            shellLookups: new Map(),
            isStopped: false,
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
                'That repo has no agent-storm.config file.',
            );
        }

        function readSettings(botId: string) {
            return (
                state.stored.bots.find((stored) => stored.botId === botId)?.settings ||
                defaultBotSettings
            );
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
            const lastRun = state.runs.get(bot.botId)?.[0];
            return lastRun
                ? lastRun.startedAt +
                      convertDuration(settings.interval || bot.entry.interval, {
                          milliseconds: true,
                      }).milliseconds
                : Date.now();
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
                loadError: bot.entry.error || undefined,
                settings: readSettings(bot.botId),
                hasApiKey: !!readApiKey(bot.botId),
                state: findBotState(bot.botId),
                nextRunAt: findNextRunAt({
                    repo,
                    bot,
                }),
                lastRun: state.runs.get(bot.botId)?.[0],
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
                const cacheKey = `${repoPath}\0${config.hash}`;
                const cached = isForced ? undefined : state.lists.get(cacheKey);
                const listed =
                    cached ||
                    (await listRepoBots(repoPath).then(
                        (list) => {
                            return {
                                list,
                            };
                        },
                        (error: unknown) => {
                            return {
                                error: [
                                    "Couldn't list the repo's bots. Is @agent-storm/bot installed at the repo root?",
                                    extractErrorMessage(error),
                                ].join(' '),
                            };
                        },
                    ));
                if ('list' in listed) {
                    state.lists.set(cacheKey, listed);
                }
                return {
                    ...repo,
                    listError: 'error' in listed ? listed.error : undefined,
                    bots:
                        'list' in listed
                            ? listed.list.bots.map((entry) => {
                                  return {
                                      botId: createBotId({
                                          repoPath,
                                          name: entry.name,
                                      }),
                                      entry,
                                  };
                              })
                            : [],
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

        async function saveRuns(botId: string, update: (runs: BotRun[]) => BotRun[]) {
            const runs = update(state.runs.get(botId) || []);
            state.runs.set(botId, runs);
            if (!state.isStopped) {
                emit('runsChanged', {
                    botId,
                });
            }
            await storage.writeRuns({
                botId,
                runs,
            });
        }

        async function updateRun(
            {botId, runId}: Readonly<{botId: string; runId: string}>,
            update: (run: BotRun) => BotRun,
        ) {
            await saveRuns(botId, (runs) => {
                return runs.map((run) => (run.id === runId ? update(run) : run));
            });
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
            await updateRun(activeRun, (run) => {
                return {
                    ...run,
                    status,
                    endedAt: Date.now(),
                    error,
                };
            });
            emitStateChanged();
            const found = findBot(activeRun.botId);
            if (isFailedRunStatus[status] && found) {
                await host.notify({
                    type: botsNotificationTypes[BotsNotificationName.RunFailed],
                    title: `The ${found.bot.entry.name} bot failed`,
                    body: error || 'The run failed.',
                    paths: [
                        botsPluginId,
                        activeRun.botId,
                    ],
                    folder: found.repo.repoPath,
                });
            }
        }

        async function startRun({
            botId,
            trigger,
        }: Readonly<{botId: string; trigger: BotRunTrigger}>) {
            const {bot} = requireBot(botId);
            if (findActiveRun(botId)) {
                throw new Error('The bot is already running.');
            }
            const runId = randomUUID();
            const token = randomBytes(32).toString('hex');
            const now = Date.now();
            state.activeRuns = [
                ...state.activeRuns,
                {
                    runId,
                    botId,
                    token,
                    heardAt: now,
                },
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
                const runFilePath = join(tempDir, `${runId}.json`);
                await writeFileAtomically({
                    path: runFilePath,
                    contents: JSON.stringify({
                        url: callServer.url,
                        token,
                        runId,
                        ai: readSettings(botId).ai,
                    } satisfies BotRunFile),
                    mode: 0o600,
                });
                const shell = await ensureBotShell(botId);
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
                'origin' | 'text' | 'isInWorktree' | 'env' | 'title'
            > & {
                run: Readonly<ActiveRun>;
                ai: Readonly<BotAi>;
            }
        >) {
            return await (
                await requireBuild()
            ).startPluginThread({
                ...params,
                cwd: requireBot(run.botId).repo.repoPath,
                provider: buildProviders[ai.provider],
                model: ai.model,
                effort: ai.effort ? buildEfforts[ai.effort] : undefined,
                runtimeMode: readSettings(run.botId).runtimeMode,
                apiKey: readApiKey(run.botId),
            });
        }

        async function runSchedule() {
            const now = Date.now();
            const silentRuns = state.activeRuns.filter((run) => {
                return (
                    now - run.heardAt >
                    convertDuration(
                        {
                            minutes: 2,
                        },
                        {
                            milliseconds: true,
                        },
                    ).milliseconds
                );
            });
            await Promise.all(
                silentRuns.map(async (run) => {
                    await finishRun({
                        runId: run.runId,
                        status: BotRunStatus.Interrupted,
                        error: 'Agent Storm stopped hearing from the run.',
                    });
                }),
            );
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
            async report({run, request}) {
                await updateRun(run, (stored) => {
                    return {
                        ...stored,
                        reports: [
                            ...stored.reports,
                            request.line,
                        ].slice(-maxReportsPerRun),
                    };
                });
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
                const thread = await startRunThread({
                    run,
                    ai: request.ai,
                    origin: ThreadOrigin.Bot,
                    text: request.text,
                    isInWorktree: false,
                    env: request.env,
                    title: `${requireBot(run.botId).bot.entry.name} bot run`,
                });
                await updateRun(run, (stored) => {
                    return {
                        ...stored,
                        aiThreadIds: [
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
                return {
                    status: thread ? aiRunStatuses[thread.status] : BotAiRunStatus.Failed,
                };
            },
            async askQuestion({run, request}) {
                const {repo, bot} = requireBot(run.botId);
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
                    title: `The ${bot.entry.name} bot asks`,
                    body: request.question,
                    paths: [
                        botsPluginId,
                        run.botId,
                    ],
                    folder: repo.repoPath,
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
                const thread = await startRunThread({
                    run,
                    ai: request.ai,
                    origin: ThreadOrigin.User,
                    text: request.text,
                    isInWorktree: request.isInWorktree,
                    env: {},
                    title: request.title || undefined,
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
            async createWorktree({run, request}) {
                const {repo} = requireBot(run.botId);
                return await host.createWorktree({
                    folder: repo.repoPath,
                    name: request.name,
                    scope: toBotScope(run.botId),
                });
            },
            async notify({run, request}) {
                const {repo} = requireBot(run.botId);
                await host.notify({
                    type: botsNotificationTypes[BotsNotificationName.Message],
                    title: request.title,
                    body: request.body,
                    paths: [
                        botsPluginId,
                        run.botId,
                    ],
                    folder: repo.repoPath,
                });
                return {};
            },
        };

        const callServer = await startBotCallServer({
            findRun(token) {
                const run = state.activeRuns.find((active) => active.token === token);
                if (run) {
                    run.heardAt = Date.now();
                }
                return run;
            },
            handlers: runHandlers,
        });

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
                    'The repo no longer has an agent-storm.config file.',
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
                        'The config file changed since you read it. Read it again first.',
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
            async updateBotSettings({botId, settings}) {
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
                return {};
            },
            async setApiKey({botId, apiKey}) {
                requireBot(botId);
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
                return {};
            },
            async runNow({botId}) {
                const {repo, bot} = requireBot(botId);
                if (readApproval(repo) !== BotConfigApproval.Approved) {
                    throw new Error("Approve the repo's agent-storm.config file first.");
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
                state.isStopped = true;
                timers.forEach((timer) => {
                    clearInterval(timer);
                });
                await callServer.close();
            },
        };
    },
});
