import {type FolderInfo} from '@agent-storm/common';
import {type PluginCallHandlers, type PluginServerHost} from '@agent-storm/core/server';
import {getEnumValues, type PartialWithUndefined, selectFrom} from '@augment-vir/common';
import {assertValidShape} from 'object-shape-tester';
import {type JSONSchema, mapSchemaToShape} from 'schema-vir';
import {
    AiProvider,
    ApprovalDecision,
    type ApprovalRequest,
    type buildApi,
    ReasoningEffort,
    RuntimeMode,
    type Thread,
    ThreadItemKind,
} from '../build-api.js';
import {type ThreadStore} from './thread-store.js';

/** What Agent Storm's tools reach the plugin through. */
export type AgentToolContext = Readonly<{
    calls: PluginCallHandlers<typeof buildApi>;
    findThread: ThreadStore['findThread'];
    isThreadActive: ThreadStore['isThreadActive'];
    listFolders: PluginServerHost['listFolders'];
    /** Asks the thread's user to approve something and waits, whatever the thread's runtime mode. */
    requestApproval(
        params: Readonly<
            Pick<ApprovalRequest, 'threadId' | 'title' | 'detail' | 'reason'> & {
                signal: AbortSignal | undefined;
            }
        >,
    ): Promise<ApprovalDecision>;
    /**
     * Adds a message to the thread that shows the image files at `imagePaths` under `caption`.
     * Rejects a path that isn't an absolute path to a readable image file.
     */
    showImages(
        params: Readonly<{
            threadId: string;
            imagePaths: ReadonlyArray<string>;
            /** Markdown. */
            caption: string;
        }>,
    ): Promise<void>;
    /**
     * Shows the file at `path`, absolute or relative to the thread's folder, in a Viewer tab beside
     * the thread's chat in every open window, and returns its absolute path. Rejects a file the
     * Viewer can't show.
     */
    showFile(
        params: Readonly<{
            threadId: string;
            path: string;
        }>,
    ): Promise<string>;
    /**
     * The slash command, with any arguments, that Agent Storm's worktree skills review a folder's
     * work with. Empty when there's none.
     */
    findReviewSkill(folder: Readonly<FolderInfo>): Promise<string>;
    /** Counts the commits checked out at `folder` that its repo's `origin/HEAD` doesn't have. */
    countCommitsPastDefaultBranch(folder: string): Promise<number>;
    /**
     * Renames the thread's worktree branch to `branch` while that branch still has a placeholder
     * name and hasn't been pushed, and returns whether it did.
     */
    renamePlaceholderBranch(params: Readonly<{threadId: string; branch: string}>): Promise<boolean>;
    /**
     * Runs `action` once the thread's current turn ends. A tool that stops the thread's own session
     * waits for this, since stopping it mid-turn would end the very call running the tool.
     */
    runAfterTurn(threadId: string, action: () => Promise<void>): void;
}>;

/** Throws when `branchName` isn't usable as both a worktree's folder name and its branch name. */
function assertValidBranchName(branchName: string | undefined) {
    if (branchName && !/^[a-zA-Z0-9][\w.-]*$/.test(branchName)) {
        throw new Error(
            `branchName "${branchName}" names both the worktree's folder and its branch, so it may hold only letters, digits, '.', '_', and '-', starting with a letter or digit.`,
        );
    }
}

/**
 * Covers worktrees made outside Agent Storm too, such as by a worktree skill, which
 * `worktreeBranch` misses.
 */
function isInWorktree({
    thread,
    folders,
}: Readonly<{
    thread: Readonly<Thread>;
    folders: ReadonlyArray<Readonly<FolderInfo>>;
}>) {
    return (
        !!thread.worktreeBranch ||
        folders.some((folder) => folder.path === thread.cwd && !!folder.parentRepoPath)
    );
}

/** Which case `move_to_worktree` took, by the calling thread's folder. */
export enum MoveToWorktreeOutcome {
    /** From a checkout or worktree root: the thread moves into a new worktree after its turn. */
    MovesAfterTurn = 'movesAfterTurn',
    /** From a worktree with no work in it yet: the thread stays and does the work there. */
    StaysInFreshWorktree = 'staysInFreshWorktree',
    /** From a worktree that has work: a new thread does the work in a new worktree. */
    StartedNewThread = 'startedNewThread',
}

/** One MCP tool, as the tool server lists and runs it. */
export type AgentTool = Readonly<{
    name: string;
    description: string;
    inputSchema: Exclude<JSONSchema, boolean> & {
        type: 'object';
    };
    /** Lets the tool run without asking the user, whatever the thread's runtime mode. */
    isReadOnly: boolean;
    /**
     * The tool asks the user itself, in every runtime mode, so providers run it without their own
     * prompt.
     */
    asksForApproval?: boolean | undefined;
    run(
        params: Readonly<{
            /** The id of the thread whose agent called the tool. */
            callerId: string;
            input: unknown;
            context: AgentToolContext;
            /** Aborts when the agent stops waiting for the tool. */
            signal: AbortSignal;
        }>,
    ): Promise<unknown>;
}>;

/** Checks the tool's input against `inputSchema` before `run` gets it. */
function defineAgentTool<const Schema extends AgentTool['inputSchema']>({
    inputSchema,
    run,
    ...tool
}: Readonly<
    Pick<AgentTool, 'name' | 'description' | 'isReadOnly' | 'asksForApproval'> & {
        inputSchema: Schema;
        run(
            params: Readonly<{
                callerId: string;
                input: ReturnType<typeof mapSchemaToShape<Schema>>['runtimeType'];
                context: AgentToolContext;
                signal: AbortSignal;
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
    ThreadItemKind.QuestionAnswer,
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
    "Before changing files, find this thread's folder with list_folders. In a plain checkout (isWorktreeRoot false), change files right there, and use move_to_worktree only when the user asks for a worktree. In a worktree root (isWorktreeRoot true), call move_to_worktree first. To start work in a new worktree from any folder, call move_to_worktree once and follow what it returns: it moves this thread out of a checkout, keeps this thread in a worktree that has no work yet, and otherwise starts a new thread in a new worktree. A thread in a worktree never leaves it: work for an existing worktree goes to a new thread from create_thread with repoPath set to that worktree's folder, and separate work that should end in its own PR goes to create_thread with isInWorktree. Make worktrees only with move_to_worktree or create_thread, never with `git worktree add`, and change files only inside this thread's folder: the user finds a thread's changes through its folder.",
    "When this thread's first message refers to work described elsewhere instead of stating it, such as in a linked Slack thread, ticket, or document, call rename_thread with a 1 to 4 word title for the whole task as soon as you have read that description.",
    "Tools that restart or stop this thread's session (move_to_worktree when it moves this thread, move_to_folder, archive_thread on this thread, and configure_thread changing this thread's model) take effect when your turn ends, so call them last and then end your turn.",
    'The chat shows images inline: to show the user an image file, call show_image, or put a Markdown image with its absolute path in your reply, such as ![Chart](/tmp/chart.png).',
    'To show the user a rendered HTML page, Markdown file, or image in a tab beside the chat, call show_file.',
    'When you need the user to approve or decide something and you have a tool for asking questions, such as AskUserQuestion, ask through it rather than ending your reply with a question: the sidebar shows a thread as waiting on the user only while such a request is open. If the user replies with a question or objection instead of a choice, answer it in chat and end your turn without asking again.',
].join(' ');

export const agentTools: ReadonlyArray<AgentTool> = [
    defineAgentTool({
        name: 'show_image',
        description:
            "Shows the user image files inline in this thread's chat, as a message of their own. Use it for a screenshot, chart, or any other image the user should see. The images aren't sent back to you.",
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                paths: {
                    type: 'array',
                    items: {
                        type: 'string',
                    },
                    minItems: 1,
                    description: 'Absolute paths of PNG, JPEG, GIF, WebP, or SVG files.',
                },
                caption: {
                    type: 'string',
                    description: 'Markdown to show above the images.',
                },
            },
            required: [
                'paths',
            ],
        },
        async run({callerId, input, context}) {
            await context.showImages({
                threadId: callerId,
                imagePaths: input.paths,
                caption: input.caption || '',
            });
            return {
                ok: true,
            };
        },
    }),
    defineAgentTool({
        name: 'show_file',
        description:
            "Opens an HTML, Markdown, or image file in a Viewer tab in the right column of this thread's tabs, beside the chat, adding that column when there is none. Use it for a report, mockup, diagram, or anything else the user should see rendered rather than read as source. The tab reloads the file while it's shown, so rewriting the file updates it. The page is loaded from its contents rather than its location, so inline its CSS, scripts, and images instead of linking files beside it. Scripts run in a sandbox that can't reach the app.",
        isReadOnly: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                path: {
                    type: 'string',
                    description:
                        "Absolute, starting with ~/, or relative to this thread's folder. An .html, .htm, .md, .markdown, or image file.",
                },
            },
            required: [
                'path',
            ],
        },
        async run({callerId, input, context}) {
            return {
                ok: true,
                path: await context.showFile({
                    threadId: callerId,
                    path: input.path,
                }),
            };
        },
    }),
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
            "Lists one repo's folders in Agent Storm's sidebar: its checkout and its worktrees, with each one's branch, git state, PR, and reviewSkill: the slash command, with any arguments, that Agent Storm's worktree skills review work in that folder with, empty for none.",
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
                folders: await Promise.all(
                    folders
                        .filter((folder) => {
                            return folder.path === rootPath || folder.parentRepoPath === rootPath;
                        })
                        .map(async (folder) => {
                            return {
                                ...selectFrom(folder, {
                                    path: true,
                                    name: true,
                                    parentRepoPath: true,
                                    isWorktreeRoot: true,
                                    branch: true,
                                    git: true,
                                    prUrl: true,
                                    prBaseBranch: true,
                                    prStatus: true,
                                }),
                                reviewSkill: await context.findReviewSkill(folder),
                            };
                        }),
                ),
            };
        },
    }),
    defineAgentTool({
        name: 'move_to_worktree',
        description: [
            "Starts this thread's work in a new git worktree, on a new branch, and runs the repo's post-worktree command there. Returns `outcome`, saying which of three cases happened, and a `message` to follow.",
            `${MoveToWorktreeOutcome.MovesAfterTurn}: from a checkout or worktree root, this thread moves into the new worktree when your turn ends, then gets continuationPrompt, so call this last and then end your turn.`,
            `${MoveToWorktreeOutcome.StaysInFreshWorktree}: from a worktree with no work yet (no commits past origin/HEAD, no uncommitted changes, and no PR) and no baseFolder, nothing moves, so keep working right here in this same turn.`,
            `${MoveToWorktreeOutcome.StartedNewThread}: from a worktree that has work, a new thread starts in a new worktree with continuationPrompt as its first message, which this case requires. Returns its threadId and folder. End your turn.`,
            'Asks the user to approve making a worktree, unless they already asked for one, and fails if they decline.',
        ].join(' '),
        isReadOnly: false,
        asksForApproval: true,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                continuationPrompt: {
                    type: 'string',
                    description:
                        'The work to do in the new worktree. Sent to this thread once it moves, or to the new thread as its first message. Omit to wait for the user after a move.',
                },
                branchName: {
                    type: 'string',
                    description:
                        "The new worktree's branch and folder name, made of letters, digits, '.', '_', and '-'. In a worktree with no work yet, renames this thread's branch to it while that branch still has a placeholder name and hasn't been pushed. Defaults to a name from this thread's title.",
                },
                isRequestedByUser: {
                    type: 'boolean',
                    description:
                        "True when the user's own message asked for a worktree, such as by invoking a worktree skill or saying they want one. Skips asking the user to approve the worktree.",
                },
                baseFolder: {
                    type: 'string',
                    description:
                        "A worktree of this thread's repo, from list_folders, whose checked-out commit the new branch starts from. Use it to stack this work on that worktree's branch.",
                },
            },
        },
        async run({callerId, input, context, signal}) {
            const thread = await context.findThread(callerId);
            const folders = await context.listFolders();
            if (
                input.baseFolder &&
                !folders.some((folder) => {
                    return (
                        folder.path === input.baseFolder &&
                        folder.parentRepoPath === thread.repoPath
                    );
                })
            ) {
                throw new Error(
                    `${input.baseFolder} isn't a worktree of ${thread.repoPath} in Agent Storm's sidebar.`,
                );
            }
            assertValidBranchName(input.branchName);
            const threadFolder = folders.find((folder) => folder.path === thread.cwd);
            const isThreadInWorktree = isInWorktree({
                thread,
                folders,
            });
            if (
                isThreadInWorktree &&
                !input.baseFolder &&
                threadFolder &&
                !threadFolder.git.dirty &&
                !threadFolder.prUrl &&
                (await context.countCommitsPastDefaultBranch(thread.cwd).catch(() => undefined)) ===
                    0
            ) {
                const isBranchRenamed = input.branchName
                    ? await context.renamePlaceholderBranch({
                          threadId: callerId,
                          branch: input.branchName,
                      })
                    : false;
                const branch =
                    (await context.findThread(callerId)).worktreeBranch || threadFolder.branch;
                return {
                    outcome: MoveToWorktreeOutcome.StaysInFreshWorktree,
                    folder: thread.cwd,
                    branch,
                    isBranchRenamed,
                    message: [
                        `This thread is already in a worktree with no work yet, at ${thread.cwd}, so it stays there. Do the work right here in this same turn: don't end your turn, and don't start another thread for it.`,
                        input.branchName && branch !== input.branchName
                            ? `Its branch keeps the name ${branch}, since only a placeholder name that hasn't been pushed gets renamed.`
                            : '',
                    ]
                        .filter(Boolean)
                        .join(' '),
                };
            } else if (isThreadInWorktree && !input.continuationPrompt) {
                throw new Error(
                    "This thread's worktree already has work, so the new work goes to a new thread in a new worktree. Call move_to_worktree again with continuationPrompt set to that work, as the new thread's first message.",
                );
            } else if (
                input.branchName &&
                folders.some((folder) => {
                    return (
                        folder.name === input.branchName &&
                        (folder.path === thread.repoPath ||
                            folder.parentRepoPath === thread.repoPath)
                    );
                })
            ) {
                throw new Error(
                    `${thread.repoPath} already has a folder named ${input.branchName}. Pass a different branchName.`,
                );
            } else {
                const decision = input.isRequestedByUser
                    ? ApprovalDecision.Approve
                    : await context.requestApproval({
                          threadId: callerId,
                          title: isThreadInWorktree
                              ? 'Start a new thread in a new worktree'
                              : 'Move this thread to a new worktree',
                          detail: [
                              isThreadInWorktree ? input.baseFolder || thread.repoPath : thread.cwd,
                              !isThreadInWorktree && input.baseFolder
                                  ? `, branched from ${input.baseFolder}`
                                  : '',
                              input.branchName ? `, on branch ${input.branchName}` : '',
                          ].join(''),
                          reason: isThreadInWorktree
                              ? "This thread's worktree already has work, so this makes a new git worktree, on a new branch, and starts a new thread in it for the new work."
                              : 'Makes a new git worktree of this folder, on a new branch, and moves this thread into it.',
                          signal,
                      });
                if (decision === ApprovalDecision.Decline) {
                    throw new Error('The user declined making a new worktree.');
                } else if (isThreadInWorktree) {
                    const {thread: newThread} = await context.calls.createThread({
                        repoPath: input.baseFolder || thread.repoPath,
                        provider: thread.provider,
                        model: thread.model,
                        effort: thread.effort,
                        /** Fast mode costs more, so it stays with the thread it was turned on in. */
                        speedTier: null,
                        runtimeMode: thread.runtimeMode,
                        text: input.continuationPrompt || '',
                        isInWorktree: true,
                        branchName: input.branchName,
                        isOpenWorktreeSkillSkipped: true,
                        isStartAwaited: true,
                        isSidebarThread: true,
                    });
                    return {
                        outcome: MoveToWorktreeOutcome.StartedNewThread,
                        threadId: newThread.id,
                        folder: newThread.cwd,
                        message: newThread.worktreeBranch
                            ? `This thread's worktree already has work, so thread ${newThread.id} started in a new worktree at ${newThread.cwd} with continuationPrompt as its first message, and does the work there. End your turn now.`
                            : `This thread's worktree already has work, so thread ${newThread.id} started with continuationPrompt as its first message, but making its worktree failed, so it works in ${newThread.cwd}. Tell the user, then end your turn.`,
                    };
                } else {
                    context.runAfterTurn(callerId, async () => {
                        const {thread} = await context.calls.moveToWorktree({
                            threadId: callerId,
                            baseFolder: input.baseFolder,
                            branchName: input.branchName,
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
                        outcome: MoveToWorktreeOutcome.MovesAfterTurn,
                        message:
                            'This thread moves to a new worktree when your turn ends. End your turn now.',
                    };
                }
            }
        },
    }),
    defineAgentTool({
        name: 'move_to_folder',
        description: [
            "Moves this thread into another folder from Agent Storm's sidebar, such as a different repo's checkout, keeping its conversation. Fails when this thread is in a worktree.",
            'The move happens when your turn ends, and the thread works in that folder from then on, so call this last and then end your turn.',
        ].join(' '),
        isReadOnly: false,
        inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                folder: {
                    type: 'string',
                    description:
                        "The folder's path, from list_folders or a thread's cwd from list_threads.",
                },
                continuationPrompt: {
                    type: 'string',
                    description:
                        'Sent to this thread once it is in the folder, to carry on the work there. Omit to wait for the user.',
                },
            },
            required: [
                'folder',
            ],
        },
        async run({callerId, input, context}) {
            const folders = await context.listFolders();
            if (!folders.some((folder) => folder.path === input.folder)) {
                throw new Error(`${input.folder} isn't a folder in Agent Storm's sidebar.`);
            } else if (
                isInWorktree({
                    thread: await context.findThread(callerId),
                    folders,
                })
            ) {
                throw new Error(
                    `This thread is in a worktree, so it stays there. Start a new thread in ${input.folder} with create_thread, passing that folder as repoPath, instead.`,
                );
            }
            context.runAfterTurn(callerId, async () => {
                const {thread} = await context.calls.moveToFolder({
                    threadId: callerId,
                    folder: input.folder,
                });
                if (input.continuationPrompt) {
                    await context.calls.sendMessage({
                        threadId: callerId,
                        text: [
                            `This thread moved to ${thread.cwd}. Work there, using paths under that folder.`,
                            input.continuationPrompt,
                        ].join('\n\n'),
                    });
                }
            });
            return {
                message: 'This thread moves when your turn ends. End your turn now.',
            };
        },
    }),
    defineAgentTool({
        name: 'create_thread',
        description:
            "Starts a new thread and sends it its first message. Returns once the thread has started, so a failed start shows in its status. Unset settings default to this thread's, except an unset speed tier, which is standard speed.",
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
                        "The folder the thread works in, from list_folders: a checkout or one of its worktrees. Defaults to this thread's checkout.",
                },
                isInWorktree: {
                    type: 'boolean',
                    description:
                        "Makes a new worktree beside the thread's folder, then runs Agent Storm's open-worktree skill on the message, which does the work, reviews it, and opens a PR.",
                },
                branchName: {
                    type: 'string',
                    description:
                        "With isInWorktree, the new worktree's branch and folder name, made of letters, digits, '.', '_', and '-'. Defaults to a name from the thread's title.",
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
            if (
                input.repoPath &&
                !(await context.listFolders()).some((folder) => folder.path === input.repoPath)
            ) {
                throw new Error(
                    `${input.repoPath} isn't a folder in Agent Storm's sidebar, so a thread there would add a new group to it. Pass a folder from list_folders as repoPath.`,
                );
            }
            assertValidBranchName(input.branchName);
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
                /** Fast mode costs more, so it stays with the thread it was turned on in. */
                speedTier: input.speedTier || null,
                runtimeMode,
                text: input.text,
                isInWorktree: !!input.isInWorktree,
                branchName: input.branchName,
                isStartAwaited: true,
                isSidebarThread: true,
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
        description:
            "Changes a thread's title in Agent Storm's sidebar. Also renames the thread's worktree branch to match while that branch still has a placeholder name and hasn't been pushed.",
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
                    deleteWorktree: input.deleteWorktree,
                });
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
            "A new model applies from the thread's next message. For this thread it applies when your turn ends. A running thread can't switch provider.",
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
export const unpromptedAgentToolNames = agentTools
    .filter((tool) => tool.isReadOnly || tool.asksForApproval)
    .map((tool) => tool.name);
