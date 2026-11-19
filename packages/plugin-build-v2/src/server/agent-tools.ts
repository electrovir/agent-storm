import {type PluginCallHandlers, type PluginServerHost} from '@agent-storm/core/server';
import {getEnumValues, type PartialWithUndefined, selectFrom} from '@augment-vir/common';
import {assertValidShape} from 'object-shape-tester';
import {type JSONSchema, mapSchemaToShape} from 'schema-vir';
import {
    AiProvider,
    type buildV2Api,
    ReasoningEffort,
    RuntimeMode,
    type Thread,
    ThreadItemKind,
} from '../build-v2-api.js';
import {type ThreadStore} from './thread-store.js';

/** What Agent Storm's tools reach the plugin through. */
export type AgentToolContext = Readonly<{
    calls: PluginCallHandlers<typeof buildV2Api>;
    findThread: ThreadStore['findThread'];
    listFolders: PluginServerHost['listFolders'];
    deleteWorktree: PluginServerHost['deleteWorktree'];
    /**
     * Runs `action` once the thread's current turn ends. A tool that stops the thread's own session
     * waits for this, since stopping it mid-turn would end the very call running the tool.
     */
    runAfterTurn(threadId: string, action: () => Promise<void>): void;
}>;

/** One MCP tool, as the tool server lists and runs it. */
export type AgentTool = Readonly<{
    name: string;
    description: string;
    inputSchema: Exclude<JSONSchema, boolean> & {
        type: 'object';
    };
    /** Lets the tool run without asking the user, whatever the thread's runtime mode. */
    isReadOnly: boolean;
    run(
        params: Readonly<{
            /** The id of the thread whose agent called the tool. */
            callerId: string;
            input: unknown;
            context: AgentToolContext;
        }>,
    ): Promise<unknown>;
}>;

/** Checks the tool's input against `inputSchema` before `run` gets it. */
function defineAgentTool<const Schema extends AgentTool['inputSchema']>({
    inputSchema,
    run,
    ...tool
}: Readonly<
    Pick<AgentTool, 'name' | 'description' | 'isReadOnly'> & {
        inputSchema: Schema;
        run(
            params: Readonly<{
                callerId: string;
                input: ReturnType<typeof mapSchemaToShape<Schema>>['runtimeType'];
                context: AgentToolContext;
            }>,
        ): Promise<unknown>;
    }
>): AgentTool {
    const inputShape = mapSchemaToShape(inputSchema);
    return {
        ...tool,
        inputSchema,
        async run({input, ...params}) {
            assertValidShape(input, inputShape);
            return await run({
                ...params,
                input,
            });
        },
    };
}

/** Higher ranks let the agent do more without asking. */
const runtimeModeRanks: Readonly<Record<RuntimeMode, number>> = {
    [RuntimeMode.Supervised]: 0,
    [RuntimeMode.AutoAcceptEdits]: 1,
    [RuntimeMode.Auto]: 2,
    [RuntimeMode.FullAccess]: 3,
};

/** Keeps an agent from getting work done in a mode that asks the user less than its own does. */
function assertWithinCallerMode({
    caller,
    runtimeMode,
}: Readonly<{caller: Readonly<Thread>; runtimeMode: RuntimeMode}>) {
    if (runtimeModeRanks[runtimeMode] > runtimeModeRanks[caller.runtimeMode]) {
        throw new Error(
            `This thread runs in ${caller.runtimeMode} mode, so it can't use a thread in ${runtimeMode} mode, which asks the user less.`,
        );
    }
}

function assertOtherThread({callerId, threadId}: Readonly<{callerId: string; threadId: string}>) {
    if (callerId === threadId) {
        throw new Error('This tool works on other threads only, not on this one.');
    }
}

/**
 * Fills a tool's unset model settings from `base`. Keeps `base`'s model, effort, and speed tier
 * only while the provider stays the same and no model is given, since they don't carry across
 * models.
 */
function resolveModelSettings({
    base,
    input,
}: Readonly<{
    base: Readonly<Thread>;
    input: Readonly<
        PartialWithUndefined<Pick<Thread, 'provider' | 'model' | 'effort' | 'speedTier'>>
    >;
}>) {
    const provider = input.provider || base.provider;
    const isBaseModel = provider === base.provider && !input.model;
    return {
        provider,
        model: input.model || (isBaseModel ? base.model : ''),
        effort: input.effort || (isBaseModel ? base.effort : null),
        speedTier: input.speedTier ?? (isBaseModel ? base.speedTier : null),
    };
}

function summarizeThread(thread: Readonly<Thread>) {
    return selectFrom(thread, {
        id: true,
        title: true,
        repoPath: true,
        cwd: true,
        worktreeBranch: true,
        provider: true,
        model: true,
        effort: true,
        speedTier: true,
        runtimeMode: true,
        status: true,
        updatedAt: true,
    });
}

/** The item kinds `read_thread` returns unless asked for the thread's activity too. */
const conversationItemKinds = [
    ThreadItemKind.UserMessage,
    ThreadItemKind.AssistantMessage,
    ThreadItemKind.Notice,
];

const otherThreadIdSchema = {
    type: 'string',
    description: "The thread's id, from list_threads.",
} as const;

const optionalThreadIdSchema = {
    type: 'string',
    description: "The thread's id, from list_threads. Omit for this thread.",
} as const;

const providerSchema = {
    type: 'string',
    enum: getEnumValues(AiProvider),
} as const;

const effortSchema = {
    type: 'string',
    enum: getEnumValues(ReasoningEffort),
    description: "One of the model's supportedEfforts, from list_models.",
} as const;

const runtimeModeSchema = {
    type: 'string',
    enum: getEnumValues(RuntimeMode),
    description:
        "How much the agent may do without asking the user, least to most. It cannot exceed this thread's own mode.",
} as const;

const modelSchema = {
    type: 'string',
    description:
        "A model id from list_models. Defaults to the thread's current model when the provider stays the same, else the provider's default model.",
} as const;

const speedTierSchema = {
    type: 'string',
    description: "One of the model's speedTiers ids, from list_models. Empty for standard speed.",
} as const;

/** What both providers show their agent about Agent Storm's tools as a whole. */
export const agentToolInstructions = [
    'Agent Storm is the app running this chat. These tools act on its chat threads, this one included, and on the folders in its sidebar.',
    'Before changing files in a repo that has worktrees in the sidebar (see list_folders), move this thread into its own worktree with move_to_worktree, unless it is in one already.',
    "Tools that restart or stop this thread's session (move_to_worktree, archive_thread on this thread, and configure_thread changing this thread's model) take effect when your turn ends, so call them last and then end your turn.",
].join(' ');

export const agentTools: ReadonlyArray<AgentTool> = [
    defineAgentTool({
        name: 'list_threads',
        description:
            "Lists Agent Storm's chat threads that aren't archived, latest activity first, and says which one is this thread.",
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
        },
        async run({callerId, context}) {
            const {threads} = await context.calls.listThreads({});
            return {
                thisThreadId: callerId,
                threads: threads.map(summarizeThread),
            };
        },
    }),
    defineAgentTool({
        name: 'read_thread',
        description:
            "Reads a thread's settings, its messages, and any requests waiting on the user.",
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: optionalThreadIdSchema,
                includeActivity: {
                    type: 'boolean',
                    description:
                        "Also returns the thread's reasoning, commands, file changes, and other tool calls, not only its messages.",
                },
            },
        },
        async run({callerId, input, context}) {
            const {thread, items, requests} = await context.calls.readThread({
                threadId: input.threadId || callerId,
            });
            return {
                thread: summarizeThread(thread),
                items: items
                    .filter((item) => {
                        return input.includeActivity || conversationItemKinds.includes(item.kind);
                    })
                    .map((item) => {
                        return selectFrom(item, {
                            kind: true,
                            status: true,
                            title: true,
                            text: true,
                        });
                    }),
                pendingRequests: requests.map((request) => {
                    return selectFrom(request, {
                        kind: true,
                        title: true,
                        reason: true,
                    });
                }),
            };
        },
    }),
    defineAgentTool({
        name: 'list_models',
        description: 'Lists the models a provider offers, with their efforts and speed tiers.',
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                provider: providerSchema,
            },
            required: [
                'provider',
            ],
        },
        async run({input, context}) {
            return await context.calls.listModels({
                provider: input.provider,
            });
        },
    }),
    defineAgentTool({
        name: 'list_folders',
        description:
            "Lists one repo's folders in Agent Storm's sidebar: its checkout and its worktrees, with each one's branch, git state, and PR.",
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                repoPath: {
                    type: 'string',
                    description:
                        "Any folder of the repo, such as a thread's repoPath from list_threads. Defaults to this thread's checkout.",
                },
            },
        },
        async run({callerId, input, context}) {
            const repoPath = input.repoPath || (await context.findThread(callerId)).repoPath;
            const folders = await context.listFolders();
            const rootPath =
                folders.find((folder) => folder.path === repoPath)?.parentRepoPath || repoPath;
            return {
                folders: folders
                    .filter(
                        (folder) => folder.path === rootPath || folder.parentRepoPath === rootPath,
                    )
                    .map((folder) => {
                        return selectFrom(folder, {
                            path: true,
                            name: true,
                            parentRepoPath: true,
                            isWorktreeRoot: true,
                            branch: true,
                            git: true,
                            prUrl: true,
                            prBaseBranch: true,
                            prStatus: true,
                        });
                    }),
            };
        },
    }),
    defineAgentTool({
        name: 'move_to_worktree',
        description: [
            "Moves this thread into a new git worktree of its checkout, on a new branch, and runs the repo's post-worktree command there.",
            'The move happens when your turn ends, and the thread works in the worktree from then on, so call this last and then end your turn.',
            'Fails if this thread is already in its own worktree.',
        ].join(' '),
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                continuationPrompt: {
                    type: 'string',
                    description:
                        'Sent to this thread once it is in the worktree, to carry on the work there. Omit to wait for the user.',
                },
            },
        },
        async run({callerId, input, context}) {
            if ((await context.findThread(callerId)).worktreeBranch) {
                throw new Error('This thread is already in its own worktree.');
            }
            context.runAfterTurn(callerId, async () => {
                const {thread} = await context.calls.moveToWorktree({
                    threadId: callerId,
                    requestId: null,
                });
                if (input.continuationPrompt) {
                    await context.calls.sendMessage({
                        threadId: callerId,
                        text: [
                            `This thread moved to a new worktree at ${thread.cwd}. Work there, using paths under that folder.`,
                            input.continuationPrompt,
                        ].join('\n\n'),
                    });
                }
            });
            return {
                message:
                    'This thread moves to a new worktree when your turn ends. End your turn now.',
            };
        },
    }),
    defineAgentTool({
        name: 'create_thread',
        description:
            "Starts a new thread and sends it its first message. Returns once the thread has started, so a failed start shows in its status. Unset settings default to this thread's.",
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                text: {
                    type: 'string',
                    description: "The new thread's first message.",
                },
                repoPath: {
                    type: 'string',
                    description:
                        "The checkout the thread belongs to, from list_folders. Defaults to this thread's.",
                },
                isInWorktree: {
                    type: 'boolean',
                    description:
                        'Moves the new thread into a new worktree beside its folder before sending its first message. For a Claude thread in a main checkout with an open-worktree skill, runs that skill on the message instead, which makes the worktree and opens a PR.',
                },
                provider: providerSchema,
                model: modelSchema,
                effort: effortSchema,
                speedTier: speedTierSchema,
                runtimeMode: runtimeModeSchema,
            },
            required: [
                'text',
            ],
        },
        async run({callerId, input, context}) {
            const caller = await context.findThread(callerId);
            const runtimeMode = input.runtimeMode || caller.runtimeMode;
            assertWithinCallerMode({
                caller,
                runtimeMode,
            });
            const {thread} = await context.calls.createThread({
                repoPath: input.repoPath || caller.repoPath,
                ...resolveModelSettings({
                    base: caller,
                    input,
                }),
                runtimeMode,
                text: input.text,
                isInWorktree: !!input.isInWorktree,
                isStartAwaited: true,
            });
            return {
                thread: summarizeThread(thread),
            };
        },
    }),
    defineAgentTool({
        name: 'send_to_thread',
        description:
            "Sends a message to another thread, as if the user typed it. Starts the thread's agent if it isn't running.",
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: otherThreadIdSchema,
                text: {
                    type: 'string',
                },
            },
            required: [
                'threadId',
                'text',
            ],
        },
        async run({callerId, input, context}) {
            assertOtherThread({
                callerId,
                threadId: input.threadId,
            });
            assertWithinCallerMode({
                caller: await context.findThread(callerId),
                runtimeMode: (await context.findThread(input.threadId)).runtimeMode,
            });
            return await context.calls.sendMessage(input);
        },
    }),
    defineAgentTool({
        name: 'interrupt_thread',
        description:
            "Stops another thread's running turn, declining every request it has waiting on the user.",
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: otherThreadIdSchema,
            },
            required: [
                'threadId',
            ],
        },
        async run({callerId, input, context}) {
            assertOtherThread({
                callerId,
                threadId: input.threadId,
            });
            assertWithinCallerMode({
                caller: await context.findThread(callerId),
                runtimeMode: (await context.findThread(input.threadId)).runtimeMode,
            });
            return await context.calls.interrupt(input);
        },
    }),
    defineAgentTool({
        name: 'rename_thread',
        description: "Changes a thread's title in Agent Storm's sidebar.",
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: optionalThreadIdSchema,
                title: {
                    type: 'string',
                },
            },
            required: [
                'title',
            ],
        },
        async run({callerId, input, context}) {
            const {thread} = await context.calls.renameThread({
                threadId: input.threadId || callerId,
                title: input.title,
            });
            return {
                thread: summarizeThread(thread),
            };
        },
    }),
    defineAgentTool({
        name: 'archive_thread',
        description: [
            "Stops a thread and hides it from Agent Storm's sidebar.",
            'For this thread it happens when your turn ends, so call it last and then end your turn.',
        ].join(' '),
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: optionalThreadIdSchema,
                deleteWorktree: {
                    type: 'boolean',
                    description:
                        "Also deletes the thread's worktree folder, uncommitted changes included. Its branch stays. Fails if the thread isn't in its own worktree or another thread works in it.",
                },
            },
        },
        async run({callerId, input, context}) {
            const threadId = input.threadId || callerId;
            const thread = await context.findThread(threadId);
            if (threadId !== callerId) {
                assertWithinCallerMode({
                    caller: await context.findThread(callerId),
                    runtimeMode: thread.runtimeMode,
                });
            }
            if (input.deleteWorktree) {
                if (!thread.worktreeBranch) {
                    throw new Error("The thread isn't in its own worktree.");
                }
                const {threads} = await context.calls.listThreads({});
                if (threads.some((other) => other.id !== threadId && other.cwd === thread.cwd)) {
                    throw new Error(
                        `Another thread works in ${thread.cwd}, so its worktree can't be deleted.`,
                    );
                }
            }
            async function archive() {
                await context.calls.archiveThread({
                    threadId,
                });
                if (input.deleteWorktree) {
                    await context.deleteWorktree({
                        worktreePath: thread.cwd,
                    });
                }
            }
            if (threadId !== callerId) {
                await archive();
                return {
                    ok: true,
                };
            }
            context.runAfterTurn(callerId, archive);
            return {
                message: 'This thread is archived when your turn ends. End your turn now.',
            };
        },
    }),
    defineAgentTool({
        name: 'configure_thread',
        description: [
            "Changes a thread's provider, model, effort, speed tier, or runtime mode. Unset settings stay as they are.",
            "A new model applies from the thread's next message. For this thread it applies when your turn ends; another thread must not be running.",
            'A new runtime mode applies right away.',
        ].join(' '),
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: optionalThreadIdSchema,
                provider: providerSchema,
                model: modelSchema,
                effort: effortSchema,
                speedTier: speedTierSchema,
                runtimeMode: runtimeModeSchema,
            },
        },
        async run({callerId, input, context}) {
            const threadId = input.threadId || callerId;
            const target = await context.findThread(threadId);
            if (input.runtimeMode) {
                assertWithinCallerMode({
                    caller: await context.findThread(callerId),
                    runtimeMode: input.runtimeMode,
                });
                await context.calls.setThreadRuntimeMode({
                    threadId,
                    runtimeMode: input.runtimeMode,
                });
            }
            if (!input.provider && !input.model && !input.effort && input.speedTier == undefined) {
                return {
                    thread: summarizeThread(await context.findThread(threadId)),
                };
            }
            const modelRequest = {
                threadId,
                ...resolveModelSettings({
                    base: target,
                    input,
                }),
            };
            if (threadId === callerId) {
                context.runAfterTurn(callerId, async () => {
                    await context.calls.setThreadModel(modelRequest);
                });
                return {
                    message: "This thread's new model applies when your turn ends.",
                };
            }
            const {thread} = await context.calls.setThreadModel(modelRequest);
            return {
                thread: summarizeThread(thread),
            };
        },
    }),
];

/** The tools that run without asking. */
export const readOnlyAgentToolNames = agentTools
    .filter((tool) => tool.isReadOnly)
    .map((tool) => tool.name);
