import {definePluginServer, type PluginCallHandlers} from '@agent-storm/core/server';
import {awaitedForEach, createCuid2, extractErrorMessage, log} from '@augment-vir/common';
import {gitTimeout, hasErrorCode, normalizePath, runCommand} from 'agent-storm-util';
import {convertDuration, createUtcFullDate, toJsDate} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {
    AiProvider,
    ApprovalDecision,
    ApprovalKind,
    type ApprovalRequest,
    buildV2Api,
    type ComposerCommand,
    providerLabels,
    type ProviderModel,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
} from '../build-v2-api.js';
import {startAgentToolServer} from './agent-tool-server.js';
import {agentToolInstructions, agentTools} from './agent-tools.js';
import {openBuildV2Database} from './build-v2-database.js';
import {createClaudeSessionStore} from './claude-session-store.js';
import {buildContextHandoff} from './context-handoff.js';
import {readFolderEnv} from './folder-env.js';
import {createClaudeProvider} from './providers/claude-provider.js';
import {codexProvider} from './providers/codex-provider.js';
import {
    type ProviderAdapter,
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
    parseGeneratedTitle,
} from './thread-names.js';
import {createThreadStore} from './thread-store.js';

const ok = {
    ok: true,
} as const;

/** A repo's Claude skill that makes a worktree for a new thread and opens a PR from it. */
const openWorktreeSkillName = 'open-worktree';

export default definePluginServer({
    api: buildV2Api,
    async start({emit, dataDir, tempDir, host}) {
        const prismaClient = await openBuildV2Database(dataDir);
        const store = createThreadStore({
            prismaClient,
            emit,
        });
        const interruptedThreads = await store.settleInterruptedWork();

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

        /**
         * A session's sink. Once the thread moves on to another session (or none), whatever the old
         * one still reports is dropped.
         */
        function createSink(threadId: string, session: {current?: Promise<ProviderSession>}) {
            function isCurrent() {
                return !!session.current && sessions.get(threadId) === session.current;
            }

            async function openRequest(
                request: Readonly<
                    Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason' | 'questions'>
                >,
                signal: AbortSignal | undefined,
            ) {
                if (!isCurrent() || signal?.aborted) {
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
                    if (!isCurrent()) {
                        return;
                    }
                    await store.updateThread(threadId, {
                        status,
                    });
                    if (status !== ThreadStatus.Running && status !== ThreadStatus.NeedsApproval) {
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
                    sink: createSink(threadId, session),
                    agentTools: agentToolServer.connect(threadId),
                });
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
            const {updatedAt} = await store.findThread(threadId);
            afterTurnActions.delete(threadId);
            await declineThreadApprovals(threadId);
            const session = sessions.get(threadId);
            sessions.delete(threadId);
            (await session?.catch(() => undefined))?.stop();
            await store.failUnfinishedItems(threadId);
            /**
             * Declining the last pending request above marks the thread running again. Stopping
             * isn't activity: passing `updatedAt` keeps Prisma's `@updatedAt` from bumping it,
             * which would move an archived thread's repo in the sidebar's activity sort.
             */
            await store.updateThread(threadId, {
                status: ThreadStatus.Idle,
                updatedAt: toJsDate(createUtcFullDate(updatedAt)),
            });
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
                status: ThreadStatus.Idle,
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
                if (details.hasCustomTitle) {
                    await renamePlaceholderBranch({
                        threadId,
                        title: (await store.findThread(threadId)).title,
                    });
                    return;
                }
                const title = parseGeneratedTitle(
                    await providers[details.provider].generateTitle({
                        cwd: details.cwd,
                        model: details.model,
                        prompt: createThreadTitlePrompt(
                            firstMessage == undefined
                                ? await store.readThread(threadId)
                                : {
                                      items: [
                                          {
                                              kind: ThreadItemKind.UserMessage,
                                              text: firstMessage,
                                          },
                                      ],
                                  },
                        ),
                    }),
                );
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

        async function sendMessage({threadId, text}: Readonly<{threadId: string; text: string}>) {
            /** A provider starting without a conversation to resume hasn't seen the thread so far. */
            const earlierItems =
                sessions.has(threadId) ||
                (await store.findSessionDetails(threadId)).providerSessionId
                    ? []
                    : (await store.readThread(threadId)).items;
            const {status} = await store.findThread(threadId);
            /** A message sent mid-turn joins that turn, so a restart can tell what it may have lost. */
            if (status !== ThreadStatus.Running && status !== ThreadStatus.NeedsApproval) {
                turnIds.set(threadId, randomUUID());
            }
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

        const calls: PluginCallHandlers<typeof buildV2Api> = {
            async listThreads() {
                const [
                    threads,
                    repoActivity,
                ] = await Promise.all([
                    store.listThreads(),
                    store.listRepoActivity(),
                ]);
                return {
                    threads,
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
            async createThread({
                id: requestedId,
                repoPath,
                provider,
                model,
                effort,
                speedTier,
                runtimeMode,
                text,
                isInWorktree,
            }) {
                const placeholderTitle = createThreadTitle(text);
                const folder = normalizePath(repoPath);
                /**
                 * The sidebar groups threads by `repoPath`, so a thread started in a worktree (such
                 * as from an AI Chat tab on a worktree folder) belongs to its main checkout.
                 */
                const folderInfo = (await host.listFolders()).find((info) => info.path === folder);
                const {id} = await store.createThread({
                    id: requestedId || createCuid2(),
                    repoPath: folderInfo?.parentRepoPath
                        ? normalizePath(folderInfo.parentRepoPath)
                        : folder,
                    worktree: folderInfo?.parentRepoPath
                        ? {
                              path: folder,
                              branch: folderInfo.branch || basename(folder),
                          }
                        : undefined,
                    provider,
                    model,
                    effort,
                    speedTier,
                    runtimeMode,
                    title: placeholderTitle,
                });
                async function startThread() {
                    const isOpenWorktreeSkillUsed =
                        isInWorktree &&
                        provider === AiProvider.Claude &&
                        !!(await stat(
                            join(folder, '.claude', 'skills', openWorktreeSkillName, 'SKILL.md'),
                        ).catch(() => undefined));
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
                                    (await generateThreadTitle({
                                        threadId: id,
                                        firstMessage: text,
                                    })) || '',
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
                    await sendMessage({
                        threadId: id,
                        text: isOpenWorktreeSkillUsed ? `/${openWorktreeSkillName} ${text}` : text,
                    });
                }
                /**
                 * Not awaited so the caller can select the new thread right away: making a
                 * worktree, generating its title, and starting the provider all take seconds.
                 */
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
                });
                return {
                    thread: await store.findThread(id),
                };
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
            async resolveRequest({requestId, decision, answers}) {
                await settleApproval(requestId, decision, answers);
                return ok;
            },
            async moveToWorktree({threadId, requestId}) {
                const thread = await store.findThread(threadId);
                if (thread.worktreeBranch) {
                    throw new Error('This thread is already in its own worktree.');
                }
                await stopSession(threadId);
                const worktreePath = await moveThreadToNewWorktree({
                    threadId,
                    folder: thread.cwd,
                    title: thread.title,
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
            async setThreadModel({threadId, provider, model, effort, speedTier}) {
                const previous = await store.findThread(threadId);
                if (
                    previous.status === ThreadStatus.Running ||
                    previous.status === ThreadStatus.NeedsApproval
                ) {
                    throw new Error('Wait for the thread to finish before switching models.');
                }
                /** The next message starts the provider again, resuming on the new model. */
                const session = sessions.get(threadId);
                sessions.delete(threadId);
                (await session?.catch(() => undefined))?.stop();
                const isNewProvider = provider !== previous.provider;
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
            async markThreadRead({threadId}) {
                await store.markThreadRead(threadId);
                return ok;
            },
            async archiveThread({threadId}) {
                await stopSession(threadId);
                await store.archiveThread(threadId);
                return ok;
            },
        };

        const agentToolServer = await startAgentToolServer({
            tools: agentTools,
            context: {
                calls,
                findThread: store.findThread,
                listFolders: host.listFolders,
                deleteWorktree: host.deleteWorktree,
                runAfterTurn(threadId, action) {
                    afterTurnActions.set(threadId, [
                        ...(afterTurnActions.get(threadId) || []),
                        action,
                    ]);
                },
            },
            instructions: agentToolInstructions,
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
                            if (!thread.worktreeBranch) {
                                return undefined;
                            }
                            const isMissing = await stat(thread.cwd).then(
                                () => false,
                                (error: unknown) => {
                                    return hasErrorCode(error, 'ENOENT');
                                },
                            );
                            return isMissing ? thread.id : undefined;
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
        interruptedThreads.forEach(({threadId, turnMessages}) => {
            if (archivedOnStartThreadIds.includes(threadId)) {
                return;
            }
            sendMessage({
                threadId,
                text: buildResumeMessage(turnMessages),
            }).catch((error: unknown) => {
                log.warning(`Resuming thread ${threadId} failed: ${extractErrorMessage(error)}`);
            });
        });

        return {
            calls,
            async stop() {
                clearInterval(deletedWorktreeSweep);
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
                await agentToolServer.stop();
                await prismaClient.$disconnect();
            },
        };
    },
});
