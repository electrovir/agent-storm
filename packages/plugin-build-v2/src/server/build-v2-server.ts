import {definePluginServer} from '@agent-storm/core/server';
import {extractErrorMessage} from '@augment-vir/common';
import {normalizePath} from 'agent-storm-util';
import {randomUUID} from 'node:crypto';
import {
    AiProvider,
    ApprovalDecision,
    buildV2Api,
    type ProviderModel,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
} from '../build-v2-api.js';
import {openBuildV2Database} from './build-v2-database.js';
import {createClaudeSessionStore} from './claude-session-store.js';
import {createClaudeProvider} from './providers/claude-provider.js';
import {codexProvider} from './providers/codex-provider.js';
import {
    type ProviderAdapter,
    type ProviderSession,
    type ProviderSink,
} from './providers/provider-session.js';
import {createThreadTitle, createWorktreeName} from './thread-names.js';
import {createThreadStore} from './thread-store.js';

const ok = {
    ok: true,
} as const;

export default definePluginServer({
    api: buildV2Api,
    async start({emit, dataDir, tempDir, host}) {
        const prismaClient = await openBuildV2Database(dataDir);
        const store = createThreadStore({
            prismaClient,
            emit,
        });
        await store.settleInterruptedWork();

        const providers: Readonly<Record<AiProvider, ProviderAdapter>> = {
            [AiProvider.Claude]: createClaudeProvider(createClaudeSessionStore(prismaClient)),
            [AiProvider.Codex]: codexProvider,
        };
        /** Each provider's models, read once. A failed read is dropped so the next call retries. */
        const modelLists = new Map<AiProvider, Promise<ProviderModel[]>>();
        /** Each thread's running provider, by thread id. */
        const sessions = new Map<string, Promise<ProviderSession>>();
        /** The turn each thread's latest message started, which its new items belong to. */
        const turnIds = new Map<string, string>();
        /** Requests waiting on the user, by request id. */
        const pendingApprovals = new Map<
            string,
            {
                threadId: string;
                resolve(decision: ApprovalDecision): void;
            }
        >();

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

        async function settleApproval(requestId: string, decision: ApprovalDecision) {
            const pending = pendingApprovals.get(requestId);
            if (!pending) {
                throw new Error('That request is no longer waiting for an answer.');
            }
            pendingApprovals.delete(requestId);
            const remaining = await store.resolveRequest({
                requestId,
                decision,
            });
            pending.resolve(decision);
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
         * A session's sink. Once the thread moves on to another session (or none), whatever the old
         * one still reports is dropped.
         */
        function createSink(threadId: string, session: {current?: Promise<ProviderSession>}) {
            function isCurrent() {
                return !!session.current && sessions.get(threadId) === session.current;
            }

            return {
                async putItem(item) {
                    if (isCurrent()) {
                        await store.putItem({
                            ...item,
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
                async setStatus(status) {
                    if (isCurrent()) {
                        await store.updateThread(threadId, {
                            status,
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
                    if (!isCurrent() || signal?.aborted) {
                        return ApprovalDecision.Decline;
                    }
                    const {id} = await store.addRequest({
                        ...request,
                        threadId,
                    });
                    const decision = new Promise<ApprovalDecision>((resolve) => {
                        pendingApprovals.set(id, {
                            threadId,
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
                    return await decision;
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
            } satisfies ProviderSink;
        }

        async function ensureSession(threadId: string) {
            const existing = sessions.get(threadId);
            if (existing) {
                return await existing;
            }
            const details = await store.findSessionDetails(threadId);
            const session: {current?: Promise<ProviderSession>} = {};
            session.current = providers[details.provider].start({
                cwd: details.cwd,
                model: details.model,
                effort: details.effort,
                runtimeMode: details.runtimeMode,
                providerSessionId: details.providerSessionId,
                sink: createSink(threadId, session),
            });
            sessions.set(threadId, session.current);
            try {
                return await session.current;
            } catch (error) {
                if (sessions.get(threadId) === session.current) {
                    sessions.delete(threadId);
                }
                throw error;
            }
        }

        async function stopSession(threadId: string) {
            await declineThreadApprovals(threadId);
            const session = sessions.get(threadId);
            sessions.delete(threadId);
            (await session?.catch(() => undefined))?.stop();
            await store.failUnfinishedItems(threadId);
            /** Declining the last pending request above marks the thread running again. */
            await store.updateThread(threadId, {
                status: ThreadStatus.Idle,
            });
        }

        async function sendMessage({threadId, text}: Readonly<{threadId: string; text: string}>) {
            turnIds.set(threadId, randomUUID());
            await store.putItem({
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
            try {
                await (await ensureSession(threadId)).send(text);
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

        return {
            calls: {
                async listThreads() {
                    return {
                        threads: await store.listThreads(),
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
                async createThread({repoPath, provider, model, effort, runtimeMode, text}) {
                    const {id} = await store.createThread({
                        repoPath: normalizePath(repoPath),
                        provider,
                        model,
                        effort,
                        runtimeMode,
                        title: createThreadTitle(text),
                    });
                    await sendMessage({
                        threadId: id,
                        text,
                    });
                    return {
                        thread: await store.findThread(id),
                    };
                },
                async readThread({threadId}) {
                    return await store.readThread(threadId);
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
                        });
                    }
                    return ok;
                },
                async resolveRequest({requestId, decision}) {
                    await settleApproval(requestId, decision);
                    return ok;
                },
                async moveToWorktree({threadId, requestId}) {
                    const thread = await store.findThread(threadId);
                    if (thread.worktreeBranch) {
                        throw new Error('This thread is already in its own worktree.');
                    }
                    await stopSession(threadId);
                    const name = createWorktreeName(thread.title);
                    const {worktreePath} = await host.createWorktree({
                        folder: thread.cwd,
                        name,
                    });
                    await store.updateThread(threadId, {
                        cwd: normalizePath(worktreePath),
                        worktreeBranch: name,
                        status: ThreadStatus.Idle,
                    });
                    await addNotice({
                        threadId,
                        text: `Moved to a new worktree at ${worktreePath}.`,
                    });
                    if (requestId) {
                        await sendMessage({
                            threadId,
                            text: [
                                `This thread moved to a new worktree at ${worktreePath}, so your last request was declined.`,
                                'Redo that work there, using paths under that folder.',
                            ].join(' '),
                        });
                    }
                    return {
                        thread: await store.findThread(threadId),
                    };
                },
                async setThreadModel({threadId, model, effort}) {
                    const {status} = await store.findThread(threadId);
                    if (status === ThreadStatus.Running || status === ThreadStatus.NeedsApproval) {
                        throw new Error('Wait for the thread to finish before switching models.');
                    }
                    /** The next message starts the provider again, resuming on the new model. */
                    const session = sessions.get(threadId);
                    sessions.delete(threadId);
                    (await session?.catch(() => undefined))?.stop();
                    return {
                        thread: await store.updateThread(threadId, {
                            model,
                            effort: effort ?? null,
                        }),
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
                        }),
                    };
                },
                async archiveThread({threadId}) {
                    await stopSession(threadId);
                    await store.archiveThread(threadId);
                    return ok;
                },
            },
            async stop() {
                [...pendingApprovals.values()].forEach((pending) => {
                    pending.resolve(ApprovalDecision.Decline);
                });
                pendingApprovals.clear();
                await Promise.all(
                    [...sessions.values()].map(async (session) => {
                        (await session.catch(() => undefined))?.stop();
                    }),
                );
                sessions.clear();
                await prismaClient.$disconnect();
            },
        };
    },
});
