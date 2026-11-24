import {
    type BuildV2ServerExports,
    findNewThreadOrigin,
    type PluginThreadTarget,
} from '@agent-storm/common';
// cspell:words unarchive unarchived unarchives unarchiving unpushed
import {
    definePluginServer,
    type HostedProcessAttachment,
    type PluginCallHandlers,
} from '@agent-storm/core/server';
import {UsageProvider, UsageSource} from '@agent-storm/plugin-usage/src/usage-api.js';
import {usageExportsKey} from '@agent-storm/plugin-usage/src/usage-exports.js';
import {assertWrap, check} from '@augment-vir/assert';
import {
    awaitedForEach,
    createCuid2,
    extractErrorMessage,
    log,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {gitTimeout, hasErrorCode, normalizePath, runCommand} from 'agent-storm-util';
import {convertDuration, createUtcFullDate, toJsDate} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {
    aiChatTabLabel,
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    type ApprovalRequest,
    buildV2Api,
    type ComposerCommand,
    isTabName,
    providerLabels,
    type ProviderModel,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadOrigin,
    ThreadStatus,
} from '../build-v2-api.js';
import {readModelDefaults} from '../util/model-default-settings.js';
import {startAgentToolServer} from './agent-tool-server.js';
import {agentToolInstructions, agentTools} from './agent-tools.js';
import {openBuildV2Database} from './build-v2-database.js';
import {checkChatImage, readChatImage, saveInlineImage} from './chat-images.js';
import {createClaudeSessionStore} from './claude-session-store.js';
import {buildContextHandoff} from './context-handoff.js';
import {readFolderEnv} from './folder-env.js';
import {applyMcpChange} from './mcp-control.js';
import {createClaudeProvider} from './providers/claude-provider.js';
import {codexProvider} from './providers/codex-provider.js';
import {
    type McpControl,
    type ProviderAdapter,
    type ProviderProcessHost,
    type ProviderSession,
    type ProviderSink,
} from './providers/provider-session.js';
import {buildResumeMessage} from './resume-message.js';
import {readUpload, saveUpload} from './save-upload.js';
import {
    createThreadTitle,
    createThreadTitlePrompt,
    createWorktreeName,
    isPlaceholderWorktreeName,
    parseGeneratedTabName,
    parseGeneratedTitle,
} from './thread-names.js';
import {createThreadStore, interruptedTurnNotice} from './thread-store.js';

const ok = {
    ok: true,
} as const;

/** Prefixes a thread's id to name its provider process in the daemon. */
const hostedProcessIdPrefix = 'build-v2:';

/** A repo's Claude skill that makes a worktree for a new thread and opens a PR from it. */
const openWorktreeSkillName = 'open-worktree';

const usageProviders: Readonly<Record<AiProvider, UsageProvider>> = {
    [AiProvider.Claude]: UsageProvider.Claude,
    [AiProvider.Codex]: UsageProvider.Codex,
};

const usageSources: Readonly<Record<ThreadOrigin, UsageSource>> = {
    [ThreadOrigin.User]: UsageSource.BuildV2,
    [ThreadOrigin.SideChat]: UsageSource.BuildV2,
    [ThreadOrigin.PaneChat]: UsageSource.BuildV2,
    [ThreadOrigin.Review]: UsageSource.Review,
    [ThreadOrigin.Watch]: UsageSource.Review,
};

/** Statuses of a thread that's mid-turn. */
const busyThreadStatuses: Readonly<Record<ThreadStatus, boolean>> = {
    [ThreadStatus.Idle]: false,
    [ThreadStatus.Running]: true,
    [ThreadStatus.NeedsApproval]: true,
    [ThreadStatus.Failed]: false,
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
    api: buildV2Api,
    async start({emit, dataDir, tempDir, host, waitForPlugin}) {
        const prismaClient = await openBuildV2Database(dataDir);
        const store = createThreadStore({
            prismaClient,
            emit,
        });
        const liveThreadIds = (
            await host.listHostedProcessIds().catch((error: unknown) => {
                log.warning(
                    `Listing AI Chat processes in the daemon failed: ${extractErrorMessage(error)}`,
                );
                return [];
            })
        )
            .filter((processId) => processId.startsWith(hostedProcessIdPrefix))
            .map((processId) => processId.slice(hostedProcessIdPrefix.length));
        const busyThreads = await store.settleInterruptedWork({
            liveThreadIds,
        });

        const providers: Readonly<Record<AiProvider, ProviderAdapter>> = {
            [AiProvider.Claude]: createClaudeProvider(createClaudeSessionStore(prismaClient)),
            [AiProvider.Codex]: codexProvider,
        };
        /** Each provider's models, read once. A failed read is dropped so the next call retries. */
        const modelLists = new Map<AiProvider, Promise<ProviderModel[]>>();
        /**
         * Each provider's commands and skills in each folder, by `provider:cwd`. Kept only briefly,
         * so a skill the user just added shows up. A failed read is dropped so the next call
         * retries.
         */
        const commandLists = new Map<
            string,
            Readonly<{
                commands: Promise<ComposerCommand[]>;
                /** Epoch milliseconds. */
                listedAt: number;
            }>
        >();
        /** Each thread's running provider, by thread id. */
        const sessions = new Map<string, Promise<ProviderSession>>();
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
                /** How many answers approving the request takes. */
                questionCount: number;
                resolve(
                    resolution: Readonly<{
                        decision: ApprovalDecision;
                        answers: ReadonlyArray<string>;
                    }>,
                ): void;
            }
        >();

        /** What Agent Storm's tools left for each thread to do once its current turn ends. */
        const afterTurnActions = new Map<string, ReadonlyArray<() => Promise<void>>>();

        async function runAfterTurnActions(threadId: string) {
            const actions = afterTurnActions.get(threadId) || [];
            afterTurnActions.delete(threadId);
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
                answers.length !== pending.questionCount
            ) {
                throw new Error(
                    `Expected ${pending.questionCount} answers but got ${answers.length}.`,
                );
            }
            pendingApprovals.delete(requestId);
            const remaining = await store.resolveRequest({
                requestId,
                decision,
            });
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

        /** Shows `request` in the thread and waits for the user's answer. */
        async function openThreadRequest({
            threadId,
            request,
            signal,
        }: Readonly<{
            threadId: string;
            request: Readonly<
                Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason' | 'questions'>
            >;
            signal: AbortSignal | undefined;
        }>) {
            if (signal?.aborted) {
                return {
                    decision: ApprovalDecision.Decline,
                    answers: [],
                };
            }
            const {id} = await store.addRequest({
                ...request,
                threadId,
            });
            const resolution = new Promise<
                Readonly<{
                    decision: ApprovalDecision;
                    answers: ReadonlyArray<string>;
                }>
            >((resolve) => {
                pendingApprovals.set(id, {
                    threadId,
                    questionCount: request.questions.length,
                    resolve,
                });
            });
            signal?.addEventListener('abort', async () => {
                if (pendingApprovals.has(id)) {
                    await settleApproval(id, ApprovalDecision.Decline);
                }
            });
            await store.updateThread(threadId, {
                status: ThreadStatus.NeedsApproval,
            });
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
                    Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason' | 'questions'>
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
                async putItem({inlineImages, imagePaths, ...item}) {
                    if (isCurrent()) {
                        const savedImagePaths = await Promise.all(
                            (inlineImages || []).map(async (image) => {
                                return await saveInlineImage({
                                    image,
                                    imagesDir: join(dataDir, 'images'),
                                });
                            }),
                        );
                        await store.putItem({
                            ...item,
                            imagePaths: [
                                ...(imagePaths || []),
                                ...savedImagePaths.filter(check.isTruthy),
                            ],
                            threadId,
                            turnId: readTurnId(threadId),
                        });
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
                async askQuestions({title, reason, questions}, signal) {
                    const {decision, answers} = await openRequest(
                        {
                            kind: ApprovalKind.Question,
                            title,
                            detail: '',
                            reason,
                            questions,
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

        function createProcessHost(threadId: string): ProviderProcessHost {
            return {
                async attach(params) {
                    const attachment = await host.attachHostedProcess({
                        ...params,
                        processId: `${hostedProcessIdPrefix}${threadId}`,
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
            await host
                .killHostedProcess(`${hostedProcessIdPrefix}${threadId}`)
                .catch((error: unknown) => {
                    log.warning(
                        `Stopping thread ${threadId}'s AI process failed: ${extractErrorMessage(error)}`,
                    );
                });
        }

        async function ensureSession(threadId: string) {
            const existing = sessions.get(threadId);
            if (existing) {
                return await existing;
            }
            const details = await store.findSessionDetails(threadId);
            const session: {current?: Promise<ProviderSession>} = {};
            /** AI Session panes get per-folder variables (such as direnv's) from their shell. */
            session.current = readFolderEnv(details.cwd).then(async (env) => {
                return await providers[details.provider].start({
                    env,
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
            const control = await openMcpControl({
                cwd: details.cwd,
                env: await readFolderEnv(details.cwd),
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
            }
        }

        async function moveThreadToNewWorktree({
            threadId,
            folder,
            title,
        }: Readonly<{threadId: string; folder: string; title: string}>) {
            const name = createWorktreeName(title);
            const {worktreePath} = await host.createWorktree({
                folder,
                name,
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

        /**
         * Has a model title the thread, unless the user or an agent renamed it. With
         * `firstMessage`, titles a new thread from that alone. Without it, reads the conversation
         * so far, so the title gets more specific as the thread goes on.
         */
        async function generateThreadTitle({
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
                        title: thread.title,
                    });
                    return;
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
                    });
                    await renamePlaceholderBranch({
                        threadId,
                        title,
                    });
                }
                return title;
            } catch (error) {
                log.warning(`Generating a thread title failed: ${extractErrorMessage(error)}`);
                return undefined;
            }
        }

        /**
         * Renames a worktree branch that was created before the thread had a usable title. Leaves a
         * pushed branch alone, since renaming it would split it from its remote branch.
         */
        async function renamePlaceholderBranch({
            threadId,
            title,
        }: Readonly<{threadId: string; title: string}>) {
            try {
                const thread = await store.findThread(threadId);
                const branch = createWorktreeName(title);
                if (
                    !thread.worktreeBranch ||
                    !isPlaceholderWorktreeName(thread.worktreeBranch) ||
                    isPlaceholderWorktreeName(branch)
                ) {
                    return;
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
                    return;
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
            } catch (error) {
                log.warning(
                    `Renaming thread ${threadId}'s branch failed: ${extractErrorMessage(error)}`,
                );
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
            isStartAwaited,
            origin,
            prUrl,
            parentThreadId,
        }: Readonly<
            Parameters<PluginCallHandlers<typeof buildV2Api>['createThread']>[0] & {
                origin: ThreadOrigin;
                prUrl: string | undefined;
            }
        >) {
            const customTitle = title?.trim();
            const folder = normalizePath(repoPath);
            /**
             * The sidebar groups threads by `repoPath`, so a thread started in a worktree (such as
             * from an AI Chat tab on a worktree folder) belongs to its main checkout.
             */
            const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
            /**
             * The skill runs inside `folder`, so from a worktree it could nest its new one there.
             * The built-in move always makes a sibling.
             */
            const isOpenWorktreeSkillUsed =
                isInWorktree &&
                !folderInfo?.parentRepoPath &&
                provider === AiProvider.Claude &&
                !!(await stat(
                    join(folder, '.claude', 'skills', openWorktreeSkillName, 'SKILL.md'),
                ).catch(() => undefined));
            const {id} = await store.createThread({
                id: requestedId || createCuid2(),
                repoPath: folderInfo?.parentRepoPath
                    ? normalizePath(folderInfo.parentRepoPath)
                    : folder,
                cwd: folder,
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
            });
            const firstMessage = isOpenWorktreeSkillUsed
                ? `/${openWorktreeSkillName} ${text}`
                : text;
            const {order} = await recordMessage({
                threadId: id,
                text: firstMessage,
            });
            async function startThread() {
                if (isInWorktree && !isOpenWorktreeSkillUsed) {
                    /**
                     * Waits for the generated title so the branch isn't named from raw message
                     * text. Without one, the branch gets a placeholder name that a later title
                     * replaces.
                     */
                    try {
                        await moveThreadToNewWorktree({
                            threadId: id,
                            folder,
                            title:
                                customTitle ||
                                (await generateThreadTitle({
                                    threadId: id,
                                    firstMessage: text,
                                })) ||
                                '',
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
                await deliverMessage({
                    threadId: id,
                    text: firstMessage,
                    order,
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

        async function findPluginThread({cwd, origin}: PluginThreadTarget) {
            return await store.findNewestThread({
                cwd: normalizePath(cwd),
                origin,
            });
        }

        const pluginExports: BuildV2ServerExports = {
            findPluginThread,
            async sendToPluginThread({cwd, origin, prUrl, text}) {
                const existing = await findPluginThread({
                    cwd,
                    origin,
                });
                if (existing) {
                    await sendMessage({
                        threadId: existing.id,
                        text,
                    });
                    return await store.findThread(existing.id);
                }
                const folder = normalizePath(cwd);
                const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
                const modelDefaults = readModelDefaults(await host.loadSettings());
                const modelDefault = modelDefaults.folders[
                    folderInfo?.parentRepoPath ? normalizePath(folderInfo.parentRepoPath) : folder
                ] ||
                    modelDefaults.global || {
                        provider: AiProvider.Claude,
                        model: '',
                        effort: undefined,
                    };
                return (
                    await createThread({
                        id: undefined,
                        repoPath: folder,
                        provider: modelDefault.provider,
                        model: modelDefault.model,
                        effort: modelDefault.effort,
                        speedTier: undefined,
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
        };

        const calls: PluginCallHandlers<typeof buildV2Api> = {
            async listThreads() {
                const [
                    threads,
                    sideChats,
                    paneThreads,
                    repoActivity,
                ] = await Promise.all([
                    store.listThreads(),
                    store.listSideChats(),
                    store.listPaneThreads(),
                    store.listRepoActivity(),
                ]);
                return {
                    threads,
                    sideChats,
                    paneThreads,
                    repoActivity,
                };
            },
            async listModels({provider}) {
                const models =
                    modelLists.get(provider) ||
                    providers[provider].listModels({
                        cwd: tempDir,
                    });
                modelLists.set(provider, models);
                try {
                    return {
                        models: await models,
                    };
                } catch (error) {
                    modelLists.delete(provider);
                    throw error;
                }
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
                              commands: providers[provider].listCommands({
                                  cwd: commandFolder,
                              }),
                              listedAt: Date.now(),
                          };
                commandLists.set(key, entry);
                try {
                    return {
                        commands: await entry.commands,
                    };
                } catch (error) {
                    commandLists.delete(key);
                    throw error;
                }
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
            async moveToWorktree({threadId}) {
                const thread = await store.findThread(threadId);
                if (thread.worktreeBranch) {
                    throw new Error('This thread is already in its own worktree.');
                }
                await stopSession(threadId);
                await moveThreadToNewWorktree({
                    threadId,
                    folder: thread.cwd,
                    title: thread.title,
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
                return {
                    thread: await store.updateThread(threadId, {
                        title,
                        hasCustomTitle: true,
                    }),
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
                await stopSession(threadId);
                await store.archiveThread(threadId);
                if (worktreeThread?.worktreeBranch) {
                    const isWorktreeShared = (await store.listThreads()).some((other) => {
                        return other.cwd === worktreeThread.cwd;
                    });
                    if (!isWorktreeShared) {
                        await host.deleteWorktree({
                            worktreePath: worktreeThread.cwd,
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
        };

        const agentToolServer = await startAgentToolServer({
            tools: agentTools,
            context: {
                calls,
                findThread: store.findThread,
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
        async function archiveThreadsWithDeletedWorktrees() {
            try {
                const threads = await store.listThreads();
                const orphanedThreadIds = (
                    await Promise.all(
                        threads.map(async (thread) => {
                            return thread.worktreeBranch && (await isFolderMissing(thread.cwd))
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
                    `Archiving threads with deleted worktrees failed: ${extractErrorMessage(error)}`,
                );
                return [];
            }
        }

        const archivedOnStartThreadIds = await archiveThreadsWithDeletedWorktrees();
        const deletedWorktreeSweep = setInterval(
            () => {
                void archiveThreadsWithDeletedWorktrees();
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
                await agentToolServer.stop();
                await prismaClient.$disconnect();
            },
        };
    },
});
