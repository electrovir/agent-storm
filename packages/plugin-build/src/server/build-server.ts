import {
    type BuildServerExports,
    findNewThreadOrigin,
    type PluginThreadsTarget,
    type PluginThreadTarget,
    sidebarThreadOrigins,
    ViewerFileStatus,
} from '@agent-storm/common';
// cspell:words unarchive unarchived unarchives unarchiving unpushed
import {
    definePluginServer,
    type HostedProcessAttachment,
    type PluginCallHandlers,
} from '@agent-storm/core/server';
import {UsageProvider, UsageSource} from '@agent-storm/plugin-usage/src/usage-api.js';
import {usageExportsKey} from '@agent-storm/plugin-usage/src/usage-exports.js';
import {assertWrap, waitUntil} from '@augment-vir/assert';
import {
    awaitedForEach,
    createCuid2,
    extractErrorMessage,
    log,
    type PartialWithUndefined,
    removeDuplicates,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {gitTimeout, hasErrorCode, normalizePath, runCommand, tracePerfSpan} from 'agent-storm-util';
import {convertDuration, createUtcFullDate, toJsDate} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {checkValidShape} from 'object-shape-tester';
import {
    aiChatTabLabel,
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    type ApprovalRequest,
    buildApi,
    busyThreadStatuses,
    type ComposerCommand,
    isTabName,
    providerLabels,
    type ProviderModel,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadOrigin,
    threadRequestShape,
    threadShape,
    ThreadStatus,
    toThreadScope,
} from '../build-api.js';
import {
    type ModelDefault,
    readModelDefaults,
    resolveThreadModelDefault,
} from '../util/model-default-settings.js';
import {claudePluginName} from './agent-storm-skills.js';
import {startAgentToolServer} from './agent-tool-server.js';
import {agentToolInstructions, agentTools} from './agent-tools.js';
import {openBuildDatabase} from './build-database.js';
import {convertBuildV1Worktrees} from './build-v1-conversion.js';
import {checkChatImage, readChatImage} from './chat-images.js';
import {createClaudeSessionStore} from './claude-session-store.js';
import {buildContextHandoff} from './context-handoff.js';
import {readFolderEnv} from './folder-env.js';
import {openListingCache} from './listing-cache.js';
import {applyMcpChange} from './mcp-control.js';
import {type PluginLaunch} from './plugin-launch.js';
import {createClaudeProvider} from './providers/claude-provider.js';
import {codexProvider} from './providers/codex-provider.js';
import {
    type McpControl,
    type ProviderAdapter,
    type ProviderProcessHost,
    type ProviderRequestId,
    type ProviderSession,
    type ProviderSink,
} from './providers/provider-session.js';
import {buildResumeMessage} from './resume-message.js';
import {resolveReviewSkill} from './review-skill.js';
import {readUpload, saveUpload} from './save-upload.js';
import {
    createThreadTitle,
    createThreadTitlePrompt,
    createWorktreeName,
    isPlaceholderWorktreeName,
    parseGeneratedTabName,
    parseGeneratedTitle,
} from './thread-names.js';
import {createThreadNotifier} from './thread-notifications.js';
import {createThreadStore, interruptedTurnNotice} from './thread-store.js';
import {readViewerFile} from './viewer-file.js';
import {createVoiceCalls} from './voice-call.js';

const ok = {
    ok: true,
} as const;

/** Prefixes a thread's id to name its provider process in the daemon. */
const hostedProcessIdPrefix = 'build:';

/**
 * The prefix from when the plugin's id was `build-v2`. The daemon outlives the server, so processes
 * started then keep this prefix until they stop.
 */
const legacyHostedProcessIdPrefix = 'build-v2:';

function readPrefixedThreadIds({
    processIds,
    prefix,
}: Readonly<{processIds: ReadonlyArray<string>; prefix: string}>) {
    return processIds
        .filter((processId) => processId.startsWith(prefix))
        .map((processId) => processId.slice(prefix.length));
}

/** Runs Agent Storm's skill that does a new worktree thread's work and opens a PR from it. */
const openWorktreeCommands: Readonly<Record<AiProvider, string>> = {
    [AiProvider.Claude]: `/${claudePluginName}:open-worktree`,
    [AiProvider.Codex]: `$${claudePluginName}:open-worktree`,
};

const usageProviders: Readonly<Record<AiProvider, UsageProvider>> = {
    [AiProvider.Claude]: UsageProvider.Claude,
    [AiProvider.Codex]: UsageProvider.Codex,
};

const usageSources: Readonly<Record<ThreadOrigin, UsageSource>> = {
    [ThreadOrigin.User]: UsageSource.Build,
    [ThreadOrigin.SideChat]: UsageSource.Build,
    [ThreadOrigin.PaneChat]: UsageSource.Build,
    [ThreadOrigin.Review]: UsageSource.Review,
    [ThreadOrigin.Watch]: UsageSource.Review,
    [ThreadOrigin.SelfImprove]: UsageSource.Build,
    [ThreadOrigin.Bot]: UsageSource.Build,
};

async function isFolderMissing(folder: string) {
    return await stat(folder).then(
        () => false,
        (error: unknown) => {
            return hasErrorCode(error, 'ENOENT');
        },
    );
}

export default definePluginServer({
    api: buildApi,
    async start({emit, dataDir, tempDir, host, waitForPlugin}) {
        const prismaClient = await openBuildDatabase(dataDir);
        const voiceCalls = createVoiceCalls({
            emit,
            host: {
                listFolders: host.listFolders,
                loadSettings: host.loadSettings,
            },
        });
        const threadNotifier = createThreadNotifier((params) => {
            host.notify(params).catch((error: unknown) => {
                log.warning(`Sending a notification failed: ${extractErrorMessage(error)}`);
            });
        });
        const store = createThreadStore({
            prismaClient,
            emit(event, data) {
                emit(event, data);
                if (event === 'threadChanged' && checkValidShape(data, threadShape)) {
                    voiceCalls.observeThread(data);
                    threadNotifier.observeThread(data);
                } else if (
                    event === 'threadArchived' &&
                    checkValidShape(data, threadRequestShape)
                ) {
                    threadNotifier.forgetThread(data.threadId);
                }
            },
        });
        const hostedProcessIds = await host.listHostedProcessIds().catch((error: unknown) => {
            log.warning(
                `Listing AI Chat processes in the daemon failed: ${extractErrorMessage(error)}`,
            );
            return [];
        });
        /** Threads whose process the daemon still names with the legacy prefix. */
        const legacyProcessThreadIds = new Set(
            readPrefixedThreadIds({
                processIds: hostedProcessIds,
                prefix: legacyHostedProcessIdPrefix,
            }),
        );
        const liveThreadIds = [
            ...readPrefixedThreadIds({
                processIds: hostedProcessIds,
                prefix: hostedProcessIdPrefix,
            }),
            ...legacyProcessThreadIds,
        ];
        const busyThreads = await store.settleInterruptedWork({
            liveThreadIds,
        });
        try {
            const [
                groups,
                folders,
            ] = await Promise.all([
                store.listActiveThreadGroups(),
                host.listFolders().catch((error: unknown) => {
                    log.warning(
                        `Reading folders for notifications failed: ${extractErrorMessage(error)}`,
                    );
                    return [];
                }),
            ]);
            threadNotifier.seed({
                threads: [
                    ...groups.threads,
                    ...groups.sideChats,
                    ...groups.paneThreads,
                ],
                folders,
            });
        } catch (error) {
            log.warning(`Reading threads for notifications failed: ${extractErrorMessage(error)}`);
        }
        const stopFolderPrListener = host.listenToFolderPrChanges((folder) => {
            threadNotifier.observeFolder(folder);
        });
        /** Not awaited: reading the worktrees' transcripts can take a while. */
        convertBuildV1Worktrees({
            prismaClient,
            host,
            dataDir,
            async onThreadCreated(threadId) {
                emit('threadChanged', await store.findThread(threadId));
            },
        }).catch((error: unknown) => {
            log.warning(`Converting Build v1 worktrees failed: ${extractErrorMessage(error)}`);
        });

        const providers: Readonly<Record<AiProvider, ProviderAdapter>> = {
            [AiProvider.Claude]: createClaudeProvider(createClaudeSessionStore(prismaClient)),
            [AiProvider.Codex]: codexProvider,
        };
        const listingCache = await openListingCache(dataDir);
        /**
         * Each provider's models, listed once per process. Calls answer from the listing cache
         * meanwhile. A failed listing is dropped so the next call retries.
         */
        const modelLists = new Map<AiProvider, Promise<ProviderModel[]>>();
        /**
         * Each provider's commands and skills in each folder, by `provider:cwd`. Kept only briefly,
         * so a skill the user just added shows up. A failed read is dropped so the next call
         * retries.
         */
        const commandLists = new Map<
            string,
            Readonly<{
                /**
                 * Listing commands starts a whole Claude CLI process, which takes seconds, so a
                 * call answers with the last finished list while a newer one is listed.
                 */
                listing: Promise<ComposerCommand[]>;
                /** Epoch milliseconds. */
                listedAt: number;
                commands: ComposerCommand[] | undefined;
            }>
        >();
        /** Each thread's running provider, by thread id. */
        const sessions = new Map<string, Promise<ProviderSession>>();
        /** Each plugin's reader of the API keys for the threads it started, by plugin id. */
        const apiKeyReaders = new Map<
            string,
            Parameters<BuildServerExports['registerThreadOwner']>[0]['readApiKey']
        >();
        /**
         * The short-lived MCP sessions of threads without a running one, kept open while the user
         * signs in to a server, by thread id.
         */
        const mcpSignInSessions = new Map<
            string,
            Readonly<{
                control: McpControl & Readonly<{close(): void}>;
                closeTimer: NodeJS.Timeout;
            }>
        >();
        /** Each thread's connection to its provider process in the daemon, by thread id. */
        const hostedAttachments = new Map<string, HostedProcessAttachment>();
        /** Called with whether the thread's next attach started a new process. */
        const attachListeners = new Map<string, (isNew: boolean) => void>();
        /** The turn each thread's latest message started, which its new items belong to. */
        const turnIds = new Map<string, string>();
        /** Requests waiting on the user, by request id. */
        const pendingApprovals = new Map<
            string,
            {
                threadId: string;
                /** Approving the request takes an answer to each. */
                questions: ApprovalRequest['questions'];
                resolve(
                    resolution: Readonly<{
                        decision: ApprovalDecision;
                        answers: ReadonlyArray<string>;
                    }>,
                ): void;
            }
        >();

        /**
         * Requests a previous run left pending, by the id their provider repeats them with once its
         * session reconnects. Each is already tracked in `pendingApprovals`, so an answer can come
         * before the repeat does.
         */
        const restoredRequests = new Map<
            string,
            {
                requestId: string;
                threadId: string;
                resolution: Promise<
                    Readonly<{
                        decision: ApprovalDecision;
                        answers: ReadonlyArray<string>;
                    }>
                >;
            }
        >();

        function trackPendingRequest({
            requestId,
            threadId,
            questions,
        }: Readonly<{
            requestId: string;
            threadId: string;
            questions: ApprovalRequest['questions'];
        }>) {
            return new Promise<
                Readonly<{
                    decision: ApprovalDecision;
                    answers: ReadonlyArray<string>;
                }>
            >((resolve) => {
                pendingApprovals.set(requestId, {
                    threadId,
                    questions,
                    resolve,
                });
            });
        }

        /** What Agent Storm's tools left for each thread to do once its current turn ends. */
        const afterTurnActions = new Map<string, ReadonlyArray<() => Promise<void>>>();

        async function runAfterTurnActions(threadId: string) {
            const actions = afterTurnActions.get(threadId) || [];
            afterTurnActions.delete(threadId);
            try {
                await awaitedForEach(actions, async (action) => {
                    try {
                        await action();
                    } catch (error) {
                        await addNotice({
                            threadId,
                            text: extractErrorMessage(error),
                        });
                    }
                });
            } finally {
                threadNotifier.releaseFinish(threadId);
            }
        }

        function readTurnId(threadId: string) {
            return turnIds.get(threadId) || '';
        }

        async function addNotice({threadId, text}: Readonly<{threadId: string; text: string}>) {
            await store.putItem(
                store.notice({
                    threadId,
                    turnId: readTurnId(threadId),
                    text,
                }),
            );
        }

        async function settleApproval(
            requestId: string,
            decision: ApprovalDecision,
            answers: ReadonlyArray<string> = [],
        ) {
            const pending = pendingApprovals.get(requestId);
            if (!pending) {
                throw new Error('That request is no longer waiting for an answer.');
            } else if (
                decision !== ApprovalDecision.Decline &&
                answers.length !== pending.questions.length
            ) {
                throw new Error(
                    `Expected ${pending.questions.length} answers but got ${answers.length}.`,
                );
            }
            pendingApprovals.delete(requestId);
            const remaining = await store.resolveRequest({
                requestId,
                decision,
            });
            if (decision !== ApprovalDecision.Decline && pending.questions.length) {
                await store.putItem({
                    threadId: pending.threadId,
                    turnId: readTurnId(pending.threadId),
                    kind: ThreadItemKind.QuestionAnswer,
                    status: ThreadItemStatus.Completed,
                    title: '',
                    text: pending.questions
                        .map((question, index) => {
                            return [
                                `**${question.question}**`,
                                answers[index],
                            ].join('\n');
                        })
                        .join('\n\n'),
                });
            }
            pending.resolve({
                decision,
                answers,
            });
            if (
                !remaining.length &&
                (await store.findThread(pending.threadId)).status === ThreadStatus.NeedsApproval
            ) {
                await store.updateThread(pending.threadId, {
                    status: ThreadStatus.Running,
                });
            }
        }

        async function declineThreadApprovals(threadId: string) {
            await Promise.all(
                [...pendingApprovals.entries()]
                    .filter(
                        ([
                            ,
                            pending,
                        ]) => pending.threadId === threadId,
                    )
                    .map(async ([requestId]) => {
                        await settleApproval(requestId, ApprovalDecision.Decline);
                    }),
            );
        }

        /**
         * A reconnected Claude CLI repeats the requests it still waits on as its session starts, so
         * one it hasn't repeated by the end of the thread's turn will never be answered.
         */
        async function declineRestoredRequests(threadId: string) {
            await Promise.all(
                [...restoredRequests.entries()]
                    .filter(
                        ([
                            ,
                            restored,
                        ]) => restored.threadId === threadId,
                    )
                    .map(
                        async ([
                            providerRequestId,
                            restored,
                        ]) => {
                            restoredRequests.delete(providerRequestId);
                            if (pendingApprovals.has(restored.requestId)) {
                                await settleApproval(restored.requestId, ApprovalDecision.Decline);
                            }
                        },
                    ),
            );
        }

        /** Shows `request` in the thread and waits for the user's answer. */
        async function openThreadRequest({
            threadId,
            request,
            signal,
        }: Readonly<{
            threadId: string;
            request: Readonly<
                Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason' | 'questions'> &
                    ProviderRequestId
            >;
            signal: AbortSignal | undefined;
        }>) {
            if (signal?.aborted || (await store.isThreadUnattended(threadId))) {
                return {
                    decision: ApprovalDecision.Decline,
                    answers: [],
                };
            }
            const providerRequestId = request.providerRequestId || '';
            const restored = restoredRequests.get(providerRequestId);
            restoredRequests.delete(providerRequestId);
            const requestId =
                restored?.requestId ||
                (
                    await store.addRequest({
                        ...request,
                        threadId,
                    })
                ).id;
            const resolution =
                restored?.resolution ||
                trackPendingRequest({
                    requestId,
                    threadId,
                    questions: request.questions,
                });
            signal?.addEventListener('abort', async () => {
                if (pendingApprovals.has(requestId)) {
                    await settleApproval(requestId, ApprovalDecision.Decline);
                }
            });
            /** A restored request kept its thread's status, which an early answer already moved on. */
            if (!restored) {
                await store.updateThread(threadId, {
                    status: ThreadStatus.NeedsApproval,
                });
            }
            return await resolution;
        }

        /**
         * A session's sink. Once the thread moves on to another session (or none), whatever the old
         * one still reports is dropped.
         */
        function createSink(
            threadId: string,
            session: {current?: Promise<ProviderSession>},
            provider: AiProvider,
        ) {
            function isCurrent() {
                return !!session.current && sessions.get(threadId) === session.current;
            }

            async function openRequest(
                request: Readonly<
                    Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason' | 'questions'> &
                        ProviderRequestId
                >,
                signal: AbortSignal | undefined,
            ) {
                if (!isCurrent()) {
                    return {
                        decision: ApprovalDecision.Decline,
                        answers: [],
                    };
                }
                return await openThreadRequest({
                    threadId,
                    request,
                    signal,
                });
            }

            return {
                async putItem(item) {
                    if (isCurrent()) {
                        await store.putItem({
                            ...item,
                            threadId,
                            turnId: readTurnId(threadId),
                        });
                        if (
                            item.kind === ThreadItemKind.AssistantMessage &&
                            item.status === ThreadItemStatus.Completed
                        ) {
                            void titleUntitledThread(threadId);
                        }
                    }
                },
                appendDelta(params) {
                    if (isCurrent()) {
                        store.appendDelta({
                            ...params,
                            threadId,
                        });
                    }
                },
                async findItem(providerItemId) {
                    return await store.findProviderItem({
                        threadId,
                        providerItemId,
                    });
                },
                async setStatus(status) {
                    if (!isCurrent()) {
                        return;
                    }
                    if (!busyThreadStatuses[status]) {
                        /** A provider that reconnected mid-turn can miss an item's end. */
                        await store.failUnfinishedItems(threadId);
                        await declineRestoredRequests(threadId);
                        if (afterTurnActions.has(threadId)) {
                            threadNotifier.holdFinish(threadId);
                        }
                    }
                    await store.updateThread(threadId, {
                        status,
                        /**
                         * A provider that died mid-task never reports its tasks ending. An idle
                         * thread keeps its count: Claude reports a turn's result while background
                         * commands still run.
                         */
                        ...(status === ThreadStatus.Failed
                            ? {
                                  backgroundTaskCount: 0,
                              }
                            : {}),
                    });
                    if (!busyThreadStatuses[status]) {
                        void generateThreadTitle({
                            threadId,
                        });
                        /** Not awaited: these actions stop the session that is reporting this. */
                        runAfterTurnActions(threadId).catch((error: unknown) => {
                            log.warning(
                                `Finishing thread ${threadId}'s turn failed: ${extractErrorMessage(error)}`,
                            );
                        });
                    }
                },
                async reportStall() {
                    if (isCurrent()) {
                        await recoverStalledThread(threadId);
                    }
                },
                async setBackgroundTaskCount(backgroundTaskCount) {
                    if (isCurrent()) {
                        await store.updateThread(threadId, {
                            backgroundTaskCount,
                        });
                    }
                },
                async setProviderSessionId(providerSessionId) {
                    if (isCurrent()) {
                        await store.updateThread(threadId, {
                            providerSessionId,
                        });
                    }
                },
                async requestApproval(request, signal) {
                    const {decision} = await openRequest(
                        {
                            ...request,
                            questions: [],
                        },
                        signal,
                    );
                    return decision;
                },
                async askQuestions({title, reason, questions, providerRequestId}, signal) {
                    const {decision, answers} = await openRequest(
                        {
                            kind: ApprovalKind.Question,
                            title,
                            detail: '',
                            reason,
                            questions,
                            providerRequestId,
                        },
                        signal,
                    );
                    return decision === ApprovalDecision.Decline ? undefined : [...answers];
                },
                async recordUsage(usage) {
                    try {
                        const usageExports = await waitForPlugin(usageExportsKey);
                        if (!usageExports) {
                            return;
                        }
                        const thread = await store.findThread(threadId);
                        await usageExports.recordUsage({
                            ...usage,
                            source: usageSources[thread.origin],
                            provider: usageProviders[provider],
                            repoPath: thread.repoPath,
                            folder: thread.cwd,
                            threadId,
                            prUrl: thread.prUrl || undefined,
                            label: thread.title,
                        });
                    } catch (error) {
                        log.warning(
                            `Logging thread ${threadId}'s usage failed: ${extractErrorMessage(error)}`,
                        );
                    }
                },
                reportRateLimitsChanged() {
                    waitForPlugin(usageExportsKey)
                        .then((usageExports) => {
                            usageExports?.notifyRateLimitsChanged(usageProviders[provider]);
                        })
                        .catch((error: unknown) => {
                            log.warning(
                                `Telling the Usage plugin about new rate limits failed: ${extractErrorMessage(error)}`,
                            );
                        });
                },
                async addNotice(text) {
                    if (isCurrent()) {
                        await addNotice({
                            threadId,
                            text,
                        });
                    }
                },
                endSession() {
                    if (isCurrent()) {
                        sessions.delete(threadId);
                    }
                },
                releaseSession() {
                    if (isCurrent()) {
                        /** Not awaited: this stops the session that is reporting it. */
                        releaseSession(threadId).catch((error: unknown) => {
                            log.warning(
                                `Releasing thread ${threadId}'s session failed: ${extractErrorMessage(error)}`,
                            );
                        });
                    }
                },
            } satisfies ProviderSink;
        }

        function toHostedProcessId(threadId: string) {
            return [
                legacyProcessThreadIds.has(threadId)
                    ? legacyHostedProcessIdPrefix
                    : hostedProcessIdPrefix,
                threadId,
            ].join('');
        }

        function createProcessHost(threadId: string): ProviderProcessHost {
            return {
                async attach(params) {
                    const attachment = await host.attachHostedProcess({
                        ...params,
                        processId: toHostedProcessId(threadId),
                    });
                    hostedAttachments.set(threadId, attachment);
                    attachListeners.get(threadId)?.(attachment.isNew);
                    attachListeners.delete(threadId);
                    return attachment;
                },
            };
        }

        /** Stops the thread's provider, process included. */
        async function releaseSession(threadId: string) {
            const session = sessions.get(threadId);
            sessions.delete(threadId);
            hostedAttachments.delete(threadId);
            (await session?.catch(() => undefined))?.stop();
            await host.killHostedProcess(toHostedProcessId(threadId)).catch((error: unknown) => {
                log.warning(
                    `Stopping thread ${threadId}'s AI process failed: ${extractErrorMessage(error)}`,
                );
            });
            legacyProcessThreadIds.delete(threadId);
        }

        /** Waits for the plugin while it starts or restarts, as during this server's own start. */
        async function readLaunchApiKey({
            launch,
            provider,
        }: Readonly<{launch: PluginLaunch | undefined; provider: AiProvider}>) {
            if (!launch || launch.provider !== provider) {
                return undefined;
            }
            const readApiKey = await waitUntil.isDefined(
                () => apiKeyReaders.get(launch.pluginId),
                {
                    timeout: {
                        seconds: 30,
                    },
                },
                `Turn on the '${launch.pluginId}' plugin, which gives this thread's API key.`,
            );
            return await readApiKey(launch.ownerId);
        }

        async function ensureSession(threadId: string) {
            const existing = sessions.get(threadId);
            if (existing) {
                return await existing;
            }
            const details = await store.findSessionDetails(threadId);
            const session: {current?: Promise<ProviderSession>} = {};
            /** AI Session panes get per-folder variables (such as direnv's) from their shell. */
            session.current = Promise.all([
                readFolderEnv(details.cwd),
                readLaunchApiKey({
                    launch: details.pluginLaunch,
                    provider: details.provider,
                }),
            ]).then(
                async ([
                    env,
                    apiKey,
                ]) => {
                    return await tracePerfSpan('start provider session', () => {
                        return providers[details.provider].start({
                            env: {
                                ...env,
                                ...details.pluginLaunch?.env,
                            },
                            apiKey,
                            cwd: details.cwd,
                            model: details.model,
                            effort: details.effort,
                            speedTier: details.speedTier,
                            runtimeMode: details.runtimeMode,
                            providerSessionId: details.providerSessionId,
                            sink: createSink(threadId, session, details.provider),
                            agentTools: agentToolServer.connect(threadId),
                            processHost: createProcessHost(threadId),
                        });
                    });
                },
            );
            sessions.set(threadId, session.current);
            try {
                return await session.current;
            } catch (error) {
                if (sessions.get(threadId) === session.current) {
                    /** A start that failed after attaching leaves its daemon process running. */
                    await releaseSession(threadId);
                }
                throw error;
            }
        }

        /** Keeps a thread's short-lived MCP session open for a while longer, for a sign-in. */
        function holdMcpSignInSession(
            threadId: string,
            control: McpControl & Readonly<{close(): void}>,
        ) {
            clearTimeout(mcpSignInSessions.get(threadId)?.closeTimer);
            const closeTimer = setTimeout(
                () => {
                    mcpSignInSessions.delete(threadId);
                    control.close();
                },
                convertDuration(
                    {
                        minutes: 10,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            );
            closeTimer.unref();
            mcpSignInSessions.set(threadId, {
                control,
                closeTimer,
            });
        }

        /**
         * Runs `use` on the MCP servers of the thread's running session. A thread without one uses
         * a short-lived session in its folder instead of starting its own, which would skip handing
         * a provider switch's earlier messages to the next one. `isSignIn` keeps that session open
         * a while, since a sign-in's localhost callback reaches only the process that started it.
         */
        async function useThreadMcpControl<Result>({
            threadId,
            isSignIn,
            use,
        }: Readonly<{
            threadId: string;
            isSignIn: boolean;
            use: (control: McpControl, isNewSession: boolean) => Promise<Result>;
        }>) {
            const running = (await sessions.get(threadId)?.catch(() => undefined))?.mcp;
            if (running) {
                return await use(running, false);
            }
            const held = mcpSignInSessions.get(threadId)?.control;
            if (held) {
                if (isSignIn) {
                    holdMcpSignInSession(threadId, held);
                }
                return await use(held, false);
            }
            const details = await store.findSessionDetails(threadId);
            const openMcpControl = providers[details.provider].openMcpControl;
            if (!openMcpControl) {
                throw new Error(
                    `AI Chat can't manage ${providerLabels[details.provider]}'s MCP servers.`,
                );
            }
            const env = await readFolderEnv(details.cwd);
            const control = await tracePerfSpan('open MCP control', () => {
                return openMcpControl({
                    cwd: details.cwd,
                    env,
                });
            });
            if (isSignIn) {
                holdMcpSignInSession(threadId, control);
                return await use(control, true);
            }
            try {
                return await use(control, true);
            } finally {
                control.close();
            }
        }

        /** Makes `change` to the MCP servers of the thread's session, and lists them after. */
        async function changeThreadMcpServers({
            threadId,
            change,
        }: Readonly<{
            threadId: string;
            change: ((control: McpControl) => Promise<void>) | undefined;
        }>) {
            return await useThreadMcpControl({
                threadId,
                isSignIn: false,
                async use(control, isNewSession) {
                    return await applyMcpChange({
                        control,
                        change,
                        isConnectAwaited: isNewSession,
                    });
                },
            });
        }

        async function stopSession(threadId: string) {
            const {updatedAt} = await store.findThread(threadId);
            afterTurnActions.delete(threadId);
            await declineThreadApprovals(threadId);
            await releaseSession(threadId);
            await store.failUnfinishedItems(threadId);
            /**
             * Declining the last pending request above marks the thread running again. Stopping
             * isn't activity: passing `updatedAt` keeps Prisma's `@updatedAt` from bumping it,
             * which would move an archived thread's repo in the sidebar's activity sort.
             */
            await store.updateThread(threadId, {
                status: ThreadStatus.Idle,
                backgroundTaskCount: 0,
                updatedAt: toJsDate(createUtcFullDate(updatedAt)),
            });
        }

        async function recoverStalledThread(threadId: string) {
            threadNotifier.holdFinish(threadId);
            try {
                await stopSession(threadId);
                await addNotice({
                    threadId,
                    text: 'The AI stopped responding, so Agent Storm restarted it and is continuing the turn.',
                });
                await sendMessage({
                    threadId,
                    text: 'Your process stopped responding, so Agent Storm restarted it. Everything it was still running, background agents included, was stopped. Pick up where you left off.',
                });
            } catch (error) {
                log.warning(
                    `Restarting stalled thread ${threadId} failed: ${extractErrorMessage(error)}`,
                );
            } finally {
                threadNotifier.releaseFinish(threadId);
            }
        }

        async function moveThreadToNewWorktree({
            threadId,
            folder,
            name,
        }: Readonly<{threadId: string; folder: string; name: string}>) {
            const {worktreePath} = await host.createWorktree({
                folder,
                name,
                scope: toThreadScope(threadId),
            });
            await store.updateThread(threadId, {
                cwd: normalizePath(worktreePath),
                worktreeBranch: name,
            });
            await addNotice({
                threadId,
                text: `Moved to a new worktree at ${worktreePath}.`,
            });
            return worktreePath;
        }

        /** Each thread's title generation from its conversation that is still running. */
        const conversationTitleGenerations = new Map<string, Promise<string | undefined>>();

        /**
         * Has a model title the thread, unless the user or an agent renamed it, and returns the
         * title. With `firstMessage`, titles a new thread from that alone. Without it, reads the
         * conversation so far, for a thread whose first message didn't show what the work is. A
         * thread keeps its first generated title, since a later one tends to name the latest detour
         * instead of the main work. A side chat's tab name follows its own rule instead.
         */
        function generateThreadTitle({
            threadId,
            firstMessage,
        }: Readonly<{threadId: string; firstMessage?: string | undefined}>) {
            if (firstMessage != undefined) {
                return requestThreadTitle({
                    threadId,
                    firstMessage,
                });
            }
            /**
             * A turn's end starts a title generation alongside its after-turn actions, such as
             * moving to a worktree. Sharing it gives the worktree branch the same title as the
             * thread.
             */
            const running = conversationTitleGenerations.get(threadId);
            if (running) {
                return running;
            }
            const generation = requestThreadTitle({
                threadId,
            }).finally(() => {
                conversationTitleGenerations.delete(threadId);
            });
            conversationTitleGenerations.set(threadId, generation);
            return generation;
        }

        /**
         * Titles a thread mid-turn, for one whose first message didn't show the work (such as a
         * lone link). Waiting for the turn to end leaves a long turn with the raw message as its
         * title and its worktree on a placeholder branch, which a push during the turn makes
         * permanent.
         */
        async function titleUntitledThread(threadId: string) {
            try {
                const [
                    details,
                    thread,
                ] = await Promise.all([
                    store.findSessionDetails(threadId),
                    store.findThread(threadId),
                ]);
                if (!details.hasCustomTitle && thread.origin !== ThreadOrigin.SideChat) {
                    await generateThreadTitle({
                        threadId,
                    });
                }
            } catch (error) {
                log.warning(
                    `Titling thread ${threadId} mid-turn failed: ${extractErrorMessage(error)}`,
                );
            }
        }

        async function requestThreadTitle({
            threadId,
            firstMessage,
        }: Readonly<{threadId: string; firstMessage?: string | undefined}>) {
            try {
                const details = await store.findSessionDetails(threadId);
                const thread = await store.findThread(threadId);
                const isSideChat = thread.origin === ThreadOrigin.SideChat;
                /**
                 * A side chat keeps its name once it has a single word, so its tab doesn't change
                 * after every reply.
                 */
                if (
                    isSideChat &&
                    thread.title !== aiChatTabLabel &&
                    !/\s/.test(thread.title.trim())
                ) {
                    return;
                }
                /** A side chat's title only shows on its tab when it is short enough. */
                if (isSideChat && details.hasCustomTitle && !isTabName(thread.title)) {
                    await store.updateThread(threadId, {
                        hasCustomTitle: false,
                    });
                } else if (details.hasCustomTitle) {
                    await renamePlaceholderBranch({
                        threadId,
                        branch: createWorktreeName(thread.title),
                    });
                    return thread.title;
                }
                const reply = await providers[details.provider].generateTitle({
                    cwd: details.cwd,
                    model: details.model,
                    prompt: createThreadTitlePrompt({
                        ...(firstMessage == undefined
                            ? await store.readThread(threadId)
                            : {
                                  items: [
                                      {
                                          kind: ThreadItemKind.UserMessage,
                                          text: firstMessage,
                                      },
                                  ],
                              }),
                        isSideChat,
                    }),
                });
                const title = isSideChat
                    ? parseGeneratedTabName(reply)
                    : parseGeneratedTitle(reply);
                if (title) {
                    await store.setGeneratedTitle({
                        threadId,
                        title,
                        isFinal: !isSideChat,
                    });
                    await renamePlaceholderBranch({
                        threadId,
                        branch: createWorktreeName(title),
                    });
                }
                return title;
            } catch (error) {
                log.warning(`Generating a thread title failed: ${extractErrorMessage(error)}`);
                return undefined;
            }
        }

        /**
         * Renames a worktree branch that was created before the thread had a usable title, and
         * returns whether it did. Leaves a pushed branch alone, since renaming it would split it
         * from its remote branch.
         */
        async function renamePlaceholderBranch({
            threadId,
            branch,
        }: Readonly<{threadId: string; branch: string}>) {
            try {
                const thread = await store.findThread(threadId);
                if (
                    !thread.worktreeBranch ||
                    !isPlaceholderWorktreeName(thread.worktreeBranch) ||
                    isPlaceholderWorktreeName(branch)
                ) {
                    return false;
                }
                const hasUpstream = await runCommand(
                    'git',
                    [
                        'rev-parse',
                        '--abbrev-ref',
                        `${thread.worktreeBranch}@{upstream}`,
                    ],
                    {
                        cwd: thread.cwd,
                        timeout: gitTimeout,
                    },
                ).then(
                    () => true,
                    () => false,
                );
                if (hasUpstream) {
                    return false;
                }
                await runCommand(
                    'git',
                    [
                        'branch',
                        '-m',
                        thread.worktreeBranch,
                        branch,
                    ],
                    {
                        cwd: thread.cwd,
                        timeout: gitTimeout,
                    },
                );
                await store.updateThread(threadId, {
                    worktreeBranch: branch,
                });
                return true;
            } catch (error) {
                log.warning(
                    `Renaming thread ${threadId}'s branch failed: ${extractErrorMessage(error)}`,
                );
                return false;
            }
        }

        /**
         * Each new thread's start that is still making its worktree or starting its provider, with
         * the deliveries of messages sent during it chained on. Never rejects.
         */
        const pendingStarts = new Map<string, Promise<void>>();

        function trackStart(threadId: string, start: Promise<void>) {
            const tracked = start.finally(() => {
                if (pendingStarts.get(threadId) === tracked) {
                    pendingStarts.delete(threadId);
                }
            });
            pendingStarts.set(threadId, tracked);
            return tracked;
        }

        /** Shows the user's message in the thread right away and marks the thread running. */
        async function recordMessage({threadId, text}: Readonly<{threadId: string; text: string}>) {
            const {status} = await store.findThread(threadId);
            /** A message sent mid-turn joins that turn, so a restart can tell what it may have lost. */
            if (status !== ThreadStatus.Running && status !== ThreadStatus.NeedsApproval) {
                turnIds.set(threadId, randomUUID());
            }
            const item = await store.putItem({
                threadId,
                turnId: readTurnId(threadId),
                kind: ThreadItemKind.UserMessage,
                status: ThreadItemStatus.Completed,
                title: '',
                text,
            });
            await store.updateThread(threadId, {
                status: ThreadStatus.Running,
            });
            return item;
        }

        /** Sends a message {@link recordMessage} already recorded to the thread's provider. */
        async function deliverMessage({
            threadId,
            text,
            order,
        }: Readonly<{threadId: string; text: string; order: number}>) {
            /** A provider starting without a conversation to resume hasn't seen the thread so far. */
            const earlierItems =
                sessions.has(threadId) ||
                (await store.findSessionDetails(threadId)).providerSessionId
                    ? []
                    : (await store.readThread(threadId)).items.filter((item) => {
                          return item.order < order;
                      });
            /** Ends with `text` itself, after any earlier messages. */
            const handoff = buildContextHandoff({
                items: earlierItems,
                text,
            });
            try {
                await (
                    await ensureSession(threadId)
                ).send({
                    text: handoff,
                    userTextStart: handoff.length - text.length,
                });
            } catch (error) {
                await addNotice({
                    threadId,
                    text: extractErrorMessage(error),
                });
                await store.updateThread(threadId, {
                    status: ThreadStatus.Failed,
                });
            }
        }

        /**
         * A message sent while the thread is still starting waits for that start, so it reaches the
         * provider after the first message and in the thread's final folder, without holding up the
         * caller.
         */
        async function sendMessage({threadId, text}: Readonly<{threadId: string; text: string}>) {
            const {order} = await recordMessage({
                threadId,
                text,
            });
            const pendingStart = pendingStarts.get(threadId);
            if (!pendingStart) {
                await deliverMessage({
                    threadId,
                    text,
                    order,
                });
                return;
            }
            void trackStart(
                threadId,
                pendingStart
                    .then(async () => {
                        await deliverMessage({
                            threadId,
                            text,
                            order,
                        });
                    })
                    .catch((error: unknown) => {
                        log.warning(
                            `Delivering a message to thread ${threadId} failed: ${extractErrorMessage(error)}`,
                        );
                    }),
            );
        }

        async function createThread({
            id: requestedId,
            repoPath,
            provider,
            model,
            effort,
            speedTier,
            runtimeMode,
            text,
            title,
            isInWorktree,
            branchName,
            isOpenWorktreeSkillSkipped,
            isStartAwaited,
            origin,
            prUrl,
            parentThreadId,
            isPriority,
            cwd,
            pluginLaunch,
        }: Readonly<
            Parameters<PluginCallHandlers<typeof buildApi>['createThread']>[0] & {
                origin: ThreadOrigin;
                prUrl: string | undefined;
            } & PartialWithUndefined<{
                    /** Runs the thread outside `repoPath` while it stays grouped under it. */
                    cwd: string;
                    pluginLaunch: PluginLaunch;
                }>
        >) {
            const customTitle = title?.trim();
            const folder = normalizePath(repoPath);
            /**
             * The sidebar groups threads by `repoPath`, so a thread started in a worktree (such as
             * from an AI Chat tab on a worktree folder) belongs to its main checkout.
             */
            const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
            const {id} = await store.createThread({
                id: requestedId || createCuid2(),
                repoPath: folderInfo?.parentRepoPath
                    ? normalizePath(folderInfo.parentRepoPath)
                    : folder,
                cwd: cwd ? normalizePath(cwd) : folder,
                provider,
                model,
                effort,
                speedTier,
                runtimeMode,
                title:
                    customTitle ||
                    (origin === ThreadOrigin.SideChat ? aiChatTabLabel : createThreadTitle(text)),
                hasCustomTitle: !!customTitle,
                origin,
                prUrl,
                parentThreadId,
                isPriority: !!isPriority,
                pluginLaunch,
            });
            const firstMessage =
                isInWorktree && !isOpenWorktreeSkillSkipped
                    ? `${openWorktreeCommands[provider]} ${text}`
                    : text;
            const {order} = await recordMessage({
                threadId: id,
                text: firstMessage,
            });
            async function startThread() {
                if (isInWorktree) {
                    /**
                     * Waits for the generated title so the branch isn't named from raw message
                     * text. Without one, the branch gets a placeholder name that a later title
                     * replaces.
                     */
                    try {
                        if (branchName) {
                            void generateThreadTitle({
                                threadId: id,
                                firstMessage: text,
                            });
                        }
                        const worktreeName =
                            branchName ||
                            createWorktreeName(
                                customTitle ||
                                    (await tracePerfSpan('generate thread title', () => {
                                        return generateThreadTitle({
                                            threadId: id,
                                            firstMessage: text,
                                        });
                                    })) ||
                                    '',
                            );
                        await tracePerfSpan('move to new worktree', () => {
                            return moveThreadToNewWorktree({
                                threadId: id,
                                folder,
                                name: worktreeName,
                            });
                        });
                    } catch (error) {
                        await addNotice({
                            threadId: id,
                            text: `Making a worktree failed, so this thread stays in ${folder}: ${extractErrorMessage(error)}`,
                        });
                    }
                } else {
                    void generateThreadTitle({
                        threadId: id,
                        firstMessage: text,
                    });
                }
                await tracePerfSpan('deliver first message', () => {
                    return deliverMessage({
                        threadId: id,
                        text: firstMessage,
                        order,
                    });
                });
            }
            /**
             * Unless awaited, the caller can select the new thread right away: making a worktree,
             * generating its title, and starting the provider all take seconds.
             */
            const start = trackStart(
                id,
                startThread().catch(async (error: unknown) => {
                    try {
                        await store.updateThread(id, {
                            status: ThreadStatus.Failed,
                        });
                        await addNotice({
                            threadId: id,
                            text: extractErrorMessage(error),
                        });
                    } catch (failureError) {
                        log.warning(
                            `Recording thread ${id}'s failed start failed: ${extractErrorMessage(failureError)}`,
                        );
                    }
                }),
            );
            if (isStartAwaited) {
                await start;
            }
            return {
                thread: await store.findThread(id),
            };
        }

        async function findPluginThreads({folders, origin}: PluginThreadsTarget) {
            return await store.findNewestThreads({
                folders: folders.map(normalizePath),
                origin,
            });
        }

        async function findPluginThread({cwd, origin}: PluginThreadTarget) {
            const [thread] = await findPluginThreads({
                folders: [
                    cwd,
                ],
                origin,
            });
            return thread;
        }

        /** Moves a plugin's existing thread onto its origin's model setting when that changed. */
        async function switchToOriginModel({
            threadId,
            originDefault,
        }: Readonly<{
            threadId: string;
            originDefault: Readonly<ModelDefault>;
        }>) {
            const thread = await store.findThread(threadId);
            const isSameModel =
                thread.provider === originDefault.provider &&
                thread.model === originDefault.model &&
                (thread.effort || undefined) === (originDefault.effort || undefined) &&
                (thread.speedTier || undefined) === (originDefault.speedTier || undefined);
            /**
             * `setThreadModel` refuses a provider switch mid-turn, so that waits for the next
             * message.
             */
            const isProviderSwitchMidTurn =
                busyThreadStatuses[thread.status] && thread.provider !== originDefault.provider;
            if (isSameModel || isProviderSwitchMidTurn) {
                return;
            }
            await calls.setThreadModel({
                threadId,
                provider: originDefault.provider,
                model: originDefault.model,
                effort: originDefault.effort,
                speedTier: originDefault.speedTier,
            });
        }

        const pluginExports: BuildServerExports = {
            findPluginThread,
            findPluginThreads,
            async sendToPluginThread({cwd, origin, prUrl, text}) {
                const existing = await findPluginThread({
                    cwd,
                    origin,
                });
                const modelDefaults = readModelDefaults(await host.loadSettings());
                if (existing) {
                    const originDefault = modelDefaults.origins?.[origin];
                    if (originDefault) {
                        await switchToOriginModel({
                            threadId: existing.id,
                            originDefault,
                        });
                    }
                    await sendMessage({
                        threadId: existing.id,
                        text,
                    });
                    return await store.findThread(existing.id);
                }
                const folder = normalizePath(cwd);
                const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
                const modelDefault = resolveThreadModelDefault({
                    defaults: modelDefaults,
                    folder: folderInfo?.parentRepoPath
                        ? normalizePath(folderInfo.parentRepoPath)
                        : folder,
                    origin,
                });
                return (
                    await createThread({
                        id: undefined,
                        repoPath: folder,
                        provider: modelDefault.provider,
                        model: modelDefault.model,
                        effort: modelDefault.effort,
                        speedTier: modelDefault.speedTier || undefined,
                        runtimeMode: RuntimeMode.FullAccess,
                        text,
                        isInWorktree: false,
                        isStartAwaited: false,
                        origin,
                        prUrl,
                    })
                ).thread;
            },
            async compactThread(threadId) {
                if ((await store.findThread(threadId)).provider === AiProvider.Claude) {
                    await sendMessage({
                        threadId,
                        text: '/compact',
                    });
                }
            },
            async startPluginThread({
                cwd,
                origin,
                text,
                title,
                provider,
                model,
                effort,
                runtimeMode,
                isInWorktree,
                env,
                pluginId,
                ownerId,
                workingDirectory,
                isUnattended,
            }) {
                return (
                    await createThread({
                        id: createCuid2(),
                        repoPath: cwd,
                        cwd: workingDirectory,
                        provider,
                        model,
                        effort,
                        speedTier: undefined,
                        runtimeMode,
                        text,
                        title,
                        isInWorktree,
                        isStartAwaited: false,
                        origin,
                        prUrl: undefined,
                        pluginLaunch: {
                            pluginId,
                            ownerId,
                            provider,
                            env,
                            isUnattended: !!isUnattended,
                        },
                    })
                ).thread;
            },
            async continuePluginThread({threadId, text, model, effort, runtimeMode, isUnattended}) {
                if (!(await store.isThreadActive(threadId))) {
                    return undefined;
                }
                const thread = await store.findThread(threadId);
                await store.setThreadUnattended({
                    threadId,
                    isUnattended,
                });
                await switchToOriginModel({
                    threadId,
                    originDefault: {
                        provider: thread.provider,
                        model,
                        effort,
                    },
                });
                if (thread.runtimeMode !== runtimeMode) {
                    await calls.setThreadRuntimeMode({
                        threadId,
                        runtimeMode,
                    });
                }
                await sendMessage({
                    threadId,
                    text,
                });
                return await store.findThread(threadId);
            },
            async readPluginThread(threadId) {
                try {
                    return await store.findThread(threadId);
                } catch (error) {
                    /** Prisma's code for a `findUniqueOrThrow` that matched no row. */
                    if (hasErrorCode(error, 'P2025')) {
                        return undefined;
                    }
                    throw error;
                }
            },
            async interruptPluginThread(threadId) {
                await calls.interrupt({
                    threadId,
                });
            },
            registerThreadOwner({pluginId, readApiKey}) {
                apiKeyReaders.set(pluginId, readApiKey);
                return () => {
                    if (apiKeyReaders.get(pluginId) === readApiKey) {
                        apiKeyReaders.delete(pluginId);
                    }
                };
            },
        };

        const calls: PluginCallHandlers<typeof buildApi> = {
            async listThreads() {
                const [
                    groups,
                    repoActivity,
                ] = await Promise.all([
                    store.listActiveThreadGroups(),
                    store.listRepoActivity(),
                ]);
                return {
                    ...groups,
                    repoActivity,
                };
            },
            async listModels({provider}) {
                const existing = modelLists.get(provider);
                const listing =
                    existing ||
                    tracePerfSpan(`${provider} listModels`, () => {
                        return providers[provider].listModels({
                            cwd: tempDir,
                        });
                    }).then((models) => {
                        listingCache.saveModels(provider, models);
                        return models;
                    });
                if (!existing) {
                    modelLists.set(provider, listing);
                    listing.catch(() => {
                        modelLists.delete(provider);
                    });
                }
                return {
                    models: listingCache.readModels(provider) || (await listing),
                };
            },
            async listCommands({provider, cwd}) {
                const folder = normalizePath(cwd);
                const folders = await host.listFolders();
                /**
                 * A worktree root only holds the repo's worktrees and has no `.claude/skills` or
                 * `.agents/skills` of its own, so its repo skills are read from its newest
                 * worktree, the one most likely to be up to date.
                 */
                const commandFolder = folders.find((info) => info.path === folder)?.isWorktreeRoot
                    ? folders
                          .filter((info) => {
                              return (
                                  !!info.parentRepoPath &&
                                  normalizePath(info.parentRepoPath) === folder
                              );
                          })
                          .toSorted((left, right) => right.createdAtMs - left.createdAtMs)[0]
                          ?.path || folder
                    : folder;
                const key = `${provider}:${commandFolder}`;
                const cached = commandLists.get(key);
                const entry =
                    cached &&
                    Date.now() - cached.listedAt <
                        convertDuration(
                            {
                                seconds: 30,
                            },
                            {
                                milliseconds: true,
                            },
                        ).milliseconds
                        ? cached
                        : {
                              listing: tracePerfSpan(`${provider} listCommands`, () => {
                                  return providers[provider].listCommands({
                                      cwd: commandFolder,
                                  });
                              }),
                              listedAt: Date.now(),
                              commands: cached?.commands || listingCache.readCommands(key),
                          };
                if (entry !== cached) {
                    commandLists.set(key, entry);
                    void entry.listing.then(
                        (commands) => {
                            listingCache.saveCommands(key, commands);
                            if (commandLists.get(key) === entry) {
                                commandLists.set(key, {
                                    ...entry,
                                    commands,
                                });
                            }
                        },
                        () => {
                            if (commandLists.get(key) !== entry) {
                                return;
                            }
                            if (cached) {
                                commandLists.set(key, cached);
                            } else {
                                commandLists.delete(key);
                            }
                        },
                    );
                }
                return {
                    commands: entry.commands ?? (await entry.listing),
                };
            },
            async listMcpServers({threadId, isNewServerLoadEnabled}) {
                return await changeThreadMcpServers({
                    threadId,
                    change: isNewServerLoadEnabled
                        ? async (control) => {
                              await control.loadNewServers?.();
                          }
                        : undefined,
                });
            },
            async setMcpServerEnabled({threadId, serverName, isEnabled}) {
                return await changeThreadMcpServers({
                    threadId,
                    async change(control) {
                        await control.setServerEnabled({
                            serverName,
                            isEnabled,
                        });
                    },
                });
            },
            async reconnectMcpServer({threadId, serverName}) {
                return await changeThreadMcpServers({
                    threadId,
                    async change(control) {
                        await control.reconnectServer(serverName);
                    },
                });
            },
            async signInMcpServer({threadId, serverName}) {
                return await useThreadMcpControl({
                    threadId,
                    isSignIn: true,
                    async use(control, isNewSession) {
                        const signIn = await control.signIn(serverName).then(
                            (reply) => {
                                return {
                                    ...reply,
                                    error: '',
                                };
                            },
                            (caught: unknown) => {
                                return {
                                    authUrl: '',
                                    isCallbackExpected: false,
                                    error: extractErrorMessage(caught),
                                };
                            },
                        );
                        return {
                            ...(await applyMcpChange({
                                control,
                                change: undefined,
                                isConnectAwaited: isNewSession,
                            })),
                            ...signIn,
                        };
                    },
                });
            },
            async submitMcpSignInCallback({threadId, serverName, callbackUrl}) {
                return await changeThreadMcpServers({
                    threadId,
                    async change(control) {
                        await control.submitSignInCallbackUrl({
                            serverName,
                            callbackUrl,
                        });
                    },
                });
            },
            async createThread(request) {
                return await createThread({
                    ...request,
                    origin: findNewThreadOrigin(request),
                    prUrl: undefined,
                });
            },
            async readThread({threadId}) {
                return await store.readThread(threadId);
            },
            async uploadFile(request) {
                return {
                    path: await saveUpload({
                        ...request,
                        uploadsDir: tempDir,
                    }),
                };
            },
            async readUpload({path}) {
                return {
                    dataBase64: await readUpload({
                        path,
                        uploadsDir: tempDir,
                    }),
                };
            },
            async readImage({path}) {
                return await readChatImage(path);
            },
            async sendMessage(request) {
                await sendMessage(request);
                return ok;
            },
            async interrupt({threadId}) {
                await declineThreadApprovals(threadId);
                const session = sessions.get(threadId);
                if (session) {
                    await (await session).interrupt();
                } else {
                    await store.updateThread(threadId, {
                        status: ThreadStatus.Idle,
                        backgroundTaskCount: 0,
                    });
                }
                return ok;
            },
            async restartThread({threadId}) {
                await stopSession(threadId);
                await addNotice({
                    threadId,
                    text: 'Stopped the AI process. The next message starts a new one.',
                });
                return ok;
            },
            async resolveRequest({requestId, decision, answers}) {
                await settleApproval(requestId, decision, answers);
                return ok;
            },
            async moveToWorktree({threadId, baseFolder, branchName}) {
                const thread = await store.findThread(threadId);
                if (thread.worktreeBranch) {
                    throw new Error('This thread is already in its own worktree.');
                }
                await tracePerfSpan('stop session', () => stopSession(threadId));
                /**
                 * The current title may still be the first message's raw text. Without a generated
                 * title, the branch gets a placeholder name that a later title replaces.
                 */
                const name =
                    branchName ||
                    createWorktreeName(
                        (await tracePerfSpan('generate thread title', () => {
                            return generateThreadTitle({
                                threadId,
                            });
                        })) || '',
                    );
                await tracePerfSpan('move to new worktree', () => {
                    return moveThreadToNewWorktree({
                        threadId,
                        folder: baseFolder ? normalizePath(baseFolder) : thread.cwd,
                        name,
                    });
                });
                return {
                    thread: await store.findThread(threadId),
                };
            },
            async moveToFolder({threadId, folder: rawFolder}) {
                const folder = normalizePath(rawFolder);
                const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
                if (!folderInfo) {
                    throw new Error(`${folder} isn't a folder in Agent Storm's sidebar.`);
                }
                await stopSession(threadId);
                await store.updateThread(threadId, {
                    repoPath: folderInfo.parentRepoPath
                        ? normalizePath(folderInfo.parentRepoPath)
                        : folder,
                    cwd: folder,
                    /** Set only for a worktree the thread made, which archiving may delete. */
                    worktreeBranch: null,
                });
                await addNotice({
                    threadId,
                    text: `Moved to ${folder}.`,
                });
                return {
                    thread: await store.findThread(threadId),
                };
            },
            async setThreadModel({threadId, provider, model, effort, speedTier}) {
                const previous = await store.findThread(threadId);
                const isNewProvider = provider !== previous.provider;
                const isRunning = busyThreadStatuses[previous.status];
                if (isRunning && isNewProvider) {
                    throw new Error('Wait for the thread to finish before switching providers.');
                }
                if (isRunning) {
                    /** Releasing the session would end the turn, so the live session switches. */
                    await (
                        await sessions.get(threadId)?.catch(() => undefined)
                    )?.setModel({
                        model,
                        effort: effort ?? undefined,
                        speedTier: speedTier || undefined,
                    });
                } else {
                    /** The next message starts the provider again, resuming on the new model. */
                    await releaseSession(threadId);
                }
                const thread = await store.updateThread(threadId, {
                    provider,
                    model,
                    effort: effort ?? null,
                    speedTier: speedTier || null,
                    ...(isNewProvider
                        ? {
                              providerSessionId: null,
                          }
                        : {}),
                });
                if (isNewProvider) {
                    await addNotice({
                        threadId,
                        text: `Switched from ${providerLabels[previous.provider]} to ${providerLabels[provider]}. The next message gives ${providerLabels[provider]} this chat's earlier messages.`,
                    });
                }
                return {
                    thread,
                };
            },
            async setThreadRuntimeMode({threadId, runtimeMode}) {
                const thread = await store.updateThread(threadId, {
                    runtimeMode,
                });
                await (
                    await sessions.get(threadId)?.catch(() => undefined)
                )?.setRuntimeMode(runtimeMode);
                return {
                    thread,
                };
            },
            async renameThread({threadId, title}) {
                await store.updateThread(threadId, {
                    title,
                    hasCustomTitle: true,
                });
                await renamePlaceholderBranch({
                    threadId,
                    branch: createWorktreeName(title),
                });
                return {
                    thread: await store.findThread(threadId),
                };
            },
            async setThreadPriority({threadId, isPriority}) {
                return {
                    thread: await store.setThreadPriority(threadId, isPriority),
                };
            },
            async markThreadRead({threadId}) {
                await store.markThreadRead(threadId);
                return ok;
            },
            async markThreadUnread({threadId}) {
                return {
                    thread: await store.markThreadUnread(threadId),
                };
            },
            async readWorktreeChanges({threadId}) {
                const thread = await store.findThread(threadId);
                const branch = assertWrap.isTruthy(
                    thread.worktreeBranch,
                    `Thread ${threadId} has no worktree branch.`,
                );
                async function readGit(args: ReadonlyArray<string>) {
                    const {stdout} = await runCommand('git', args, {
                        cwd: thread.cwd,
                        timeout: gitTimeout,
                    });
                    return stdout.trim();
                }
                const [
                    status,
                    branchCommitCount,
                    unpushedCommitCount,
                ] = await Promise.all([
                    readGit([
                        'status',
                        '--porcelain',
                    ]),
                    /** `--exclude` applies to the next `--branches` or `--remotes` only. */
                    readGit([
                        'rev-list',
                        '--count',
                        'HEAD',
                        '--not',
                        `--exclude=${branch}`,
                        '--branches',
                        `--exclude=*/${branch}`,
                        '--remotes',
                    ]),
                    readGit([
                        'rev-list',
                        '--count',
                        'HEAD',
                        '--not',
                        '--remotes',
                    ]),
                ]);
                return {
                    hasUncommittedChanges: !!status,
                    branchCommitCount: Number(branchCommitCount),
                    unpushedCommitCount: Number(unpushedCommitCount),
                };
            },
            async archiveThread({threadId, deleteWorktree}) {
                const worktreeThread = deleteWorktree
                    ? await store.findThread(threadId)
                    : undefined;
                await tracePerfSpan('stop session', () => stopSession(threadId));
                await store.archiveThread(threadId);
                if (worktreeThread?.worktreeBranch) {
                    const isWorktreeShared = await store.hasSidebarThreadInFolder(
                        worktreeThread.cwd,
                    );
                    /**
                     * Not awaited: removing a worktree kills its panes and runs `git worktree
                     * remove`, which takes seconds, and the caller only needs the thread archived.
                     */
                    if (!isWorktreeShared) {
                        host.deleteWorktree({
                            worktreePath: worktreeThread.cwd,
                        }).catch((error: unknown) => {
                            log.warning(
                                `Deleting the worktree of archived thread ${threadId} failed: ${extractErrorMessage(error)}`,
                            );
                        });
                    }
                }
                return ok;
            },
            async listArchivedThreads() {
                return {
                    threads: await store.listArchivedThreads(),
                };
            },
            async unarchiveThread({threadId}) {
                const archived = await store.findArchivedThread(threadId);
                /**
                 * Done before unarchiving, since the deleted-worktree sweep would archive the
                 * thread again while its folder is still missing.
                 */
                const worktreePath =
                    archived.worktreeBranch && (await isFolderMissing(archived.cwd))
                        ? (
                              await host.createWorktree({
                                  folder: archived.repoPath,
                                  name: archived.worktreeBranch,
                                  scope: toThreadScope(threadId),
                              })
                          ).worktreePath
                        : undefined;
                const thread = await store.unarchiveThread({
                    threadId,
                    cwd: worktreePath ? normalizePath(worktreePath) : undefined,
                });
                if (worktreePath) {
                    await addNotice({
                        threadId,
                        text: `Unarchived into a new worktree of branch ${archived.worktreeBranch} at ${worktreePath}.`,
                    });
                }
                return {
                    thread,
                };
            },
            async startVoiceCall({sdpOffer}) {
                return await voiceCalls.startCall({
                    sdpOffer,
                    calls,
                });
            },
            endVoiceCall({callId}) {
                voiceCalls.endCall(callId);
                return ok;
            },
            readViewerFile,
        };

        const agentToolServer = await startAgentToolServer({
            tools: agentTools,
            context: {
                calls,
                findThread: store.findThread,
                isThreadActive: store.isThreadActive,
                listFolders: host.listFolders,
                async requestApproval({threadId, signal, ...request}) {
                    const {decision} = await openThreadRequest({
                        threadId,
                        request: {
                            ...request,
                            kind: ApprovalKind.Permission,
                            questions: [],
                        },
                        signal,
                    });
                    return decision;
                },
                async showImages({threadId, imagePaths, caption}) {
                    await Promise.all(imagePaths.map(checkChatImage));
                    await store.putItem({
                        threadId,
                        turnId: readTurnId(threadId),
                        kind: ThreadItemKind.AssistantMessage,
                        status: ThreadItemStatus.Completed,
                        title: '',
                        text: caption,
                        imagePaths,
                    });
                },
                async showFile({threadId, path}) {
                    const thread = await store.findThread(threadId);
                    const file = await readViewerFile({
                        folder: thread.cwd || thread.repoPath,
                        path,
                        knownModifiedAtMs: 0,
                    });
                    if (file.status !== ViewerFileStatus.Loaded) {
                        throw new Error(`Can't show ${file.resolvedPath}: ${file.status}.`);
                    }
                    emit('showViewerFile', {
                        threadId,
                        path: file.resolvedPath,
                    });
                    return file.resolvedPath;
                },
                async countCommitsPastDefaultBranch(folder) {
                    const {stdout} = await runCommand(
                        'git',
                        [
                            'rev-list',
                            '--count',
                            'origin/HEAD..HEAD',
                        ],
                        {
                            cwd: folder,
                            timeout: gitTimeout,
                        },
                    );
                    return Number(stdout.trim());
                },
                renamePlaceholderBranch,
                async findReviewSkill(folder) {
                    return resolveReviewSkill({
                        folderLayers: await host.loadFolderSettings(folder.path),
                        settings: await host.loadSettings().catch(() => undefined),
                        repoPath: folder.parentRepoPath || folder.path,
                    });
                },
                runAfterTurn(threadId, action) {
                    afterTurnActions.set(threadId, [
                        ...(afterTurnActions.get(threadId) || []),
                        action,
                    ]);
                },
            },
            instructions: agentToolInstructions,
            dataDir,
        });

        /**
         * Archives every thread whose worktree folder is gone, however it was deleted (the sidebar,
         * a merged PR's cleanup, or plain `git worktree remove`), and returns their ids.
         */
        /**
         * Covers every thread in a deleted worktree, and every thread outside the sidebar (such as
         * a review or watch thread in a deleted review copy) whose folder is gone.
         */
        async function archiveThreadsWithDeletedFolders() {
            try {
                const groups = await store.listActiveThreadGroups();
                const orphanedThreadIds = (
                    await Promise.all(
                        [
                            ...groups.threads,
                            ...groups.sideChats,
                            ...groups.paneThreads,
                        ].map(async (thread) => {
                            return (thread.worktreeBranch ||
                                !sidebarThreadOrigins.includes(thread.origin)) &&
                                (await isFolderMissing(thread.cwd))
                                ? thread.id
                                : undefined;
                        }),
                    )
                ).filter((threadId) => threadId != undefined);
                await awaitedForEach(orphanedThreadIds, async (threadId) => {
                    await calls.archiveThread({
                        threadId,
                    });
                });
                return orphanedThreadIds;
            } catch (error) {
                log.warning(
                    `Archiving threads with deleted folders failed: ${extractErrorMessage(error)}`,
                );
                return [];
            }
        }

        const archivedOnStartThreadIds = await archiveThreadsWithDeletedFolders();

        const deletedWorktreeSweep = setInterval(
            () => {
                void archiveThreadsWithDeletedFolders();
            },
            convertDuration(
                {
                    minutes: 1,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );

        /** Like a restored AI terminal pane, a thread a restart cut off is told to continue. */
        async function resumeThread({
            threadId,
            turnMessages,
        }: Readonly<{threadId: string; turnMessages: ReadonlyArray<string>}>) {
            await sendMessage({
                threadId,
                text: buildResumeMessage([...turnMessages]),
            });
        }

        /**
         * Takes over a busy thread's provider process, which kept working in the daemon while this
         * server restarted. When the process turns out to be gone, the turn is resumed instead.
         */
        async function reattachThread({
            threadId,
            turnId,
            turnMessages,
        }: Readonly<{threadId: string; turnId: string; turnMessages: ReadonlyArray<string>}>) {
            turnIds.set(threadId, turnId);
            const isNew = new Promise<boolean>((resolve) => {
                attachListeners.set(threadId, resolve);
            });
            try {
                await ensureSession(threadId);
                if (
                    !(await wrapPromiseInTimeout(
                        {
                            seconds: 30,
                        },
                        isNew,
                    ))
                ) {
                    return;
                }
            } catch (error) {
                log.warning(`Reattaching thread ${threadId} failed: ${extractErrorMessage(error)}`);
            }
            attachListeners.delete(threadId);
            await stopSession(threadId);
            await addNotice({
                threadId,
                text: interruptedTurnNotice,
            });
            await resumeThread({
                threadId,
                turnMessages,
            });
        }

        (await store.listProviderRequests()).forEach((request) => {
            restoredRequests.set(request.providerRequestId, {
                requestId: request.id,
                threadId: request.threadId,
                resolution: trackPendingRequest({
                    requestId: request.id,
                    threadId: request.threadId,
                    questions: request.questions,
                }),
            });
        });

        /**
         * An idle thread's process can still be working, as when a background command ends and
         * starts a reply, so it needs a listener too.
         */
        liveThreadIds
            .filter((threadId) => {
                return (
                    !archivedOnStartThreadIds.includes(threadId) &&
                    !busyThreads.some((thread) => thread.threadId === threadId)
                );
            })
            .forEach((threadId) => {
                ensureSession(threadId).catch((error: unknown) => {
                    log.warning(
                        `Reattaching thread ${threadId} failed: ${extractErrorMessage(error)}`,
                    );
                });
            });

        /**
         * A thread's first message after a restart waits on a login shell reading its folder's
         * environment, which takes seconds, so the latest threads' folders are read ahead. Only a
         * few: the shell reads share a small pool, and a message to any other folder would queue
         * behind them.
         */
        store
            .listThreads()
            .then(async (threads) => {
                await Promise.all(
                    removeDuplicates(threads.map((thread) => thread.cwd))
                        .slice(0, 3)
                        .map(async (cwd) => await readFolderEnv(cwd)),
                );
            })
            .catch((error: unknown) => {
                log.warning(
                    `Reading recent folders' environments failed: ${extractErrorMessage(error)}`,
                );
            });

        busyThreads.forEach((thread) => {
            if (archivedOnStartThreadIds.includes(thread.threadId)) {
                return;
            }
            (thread.isLive ? reattachThread(thread) : resumeThread(thread)).catch(
                (error: unknown) => {
                    log.warning(
                        `Resuming thread ${thread.threadId} failed: ${extractErrorMessage(error)}`,
                    );
                },
            );
        });

        return {
            calls,
            exports: pluginExports,
            async stop() {
                clearInterval(deletedWorktreeSweep);
                stopFolderPrListener();
                /**
                 * Providers keep running in the daemon, so nothing stopping below may reach them: a
                 * decline answered on the way out would stop the turn this restart should spare.
                 */
                hostedAttachments.forEach((attachment) => attachment.detach());
                hostedAttachments.clear();
                [...pendingApprovals.values()].forEach((pending) => {
                    pending.resolve({
                        decision: ApprovalDecision.Decline,
                        answers: [],
                    });
                });
                pendingApprovals.clear();
                await Promise.all(
                    [...sessions.values()].map(async (session) => {
                        (await session.catch(() => undefined))?.stop();
                    }),
                );
                sessions.clear();
                mcpSignInSessions.forEach((held) => {
                    clearTimeout(held.closeTimer);
                    held.control.close();
                });
                mcpSignInSessions.clear();
                voiceCalls.stop();
                await agentToolServer.stop();
                await prismaClient.$disconnect();
            },
        };
    },
});
