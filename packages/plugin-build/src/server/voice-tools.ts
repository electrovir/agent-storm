import {type PluginCallHandlers, type PluginServerHost} from '@agent-storm/core/server';
import {getEnumValues, selectFrom} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {basename} from 'node:path';
import {assertValidShape} from 'object-shape-tester';
import {type JSONSchema, mapSchemaToShape} from 'schema-vir';
import {
    AiProvider,
    ApprovalDecision,
    type buildApi,
    RuntimeMode,
    type Thread,
    ThreadItemKind,
} from '../build-api.js';
import {readModelDefaults} from '../util/model-default-settings.js';

/** What a voice call's tools reach the plugin through. */
export type VoiceToolContext = Readonly<{
    calls: PluginCallHandlers<typeof buildApi>;
    listFolders: PluginServerHost['listFolders'];
    loadSettings: PluginServerHost['loadSettings'];
    /** Shows the thread in the window that started the call. */
    openThread(threadId: string): void;
}>;

/** What a voice tool hands back: `output` for the model, the rest for the user's transcript. */
export type VoiceToolResult = Readonly<{
    output: unknown;
    summary: string;
    /** Empty for none. */
    threadId: string;
}>;

/** One function the realtime model can call. */
export type VoiceTool = Readonly<{
    name: string;
    description: string;
    parameters: Exclude<JSONSchema, boolean> & {
        type: 'object';
    };
    run(
        params: Readonly<{
            input: unknown;
            context: VoiceToolContext;
        }>,
    ): Promise<VoiceToolResult>;
}>;

/** Checks the tool's input against `parameters` before `run` gets it. */
function defineVoiceTool<const Schema extends VoiceTool['parameters']>({
    parameters,
    run,
    ...tool
}: Readonly<
    Pick<VoiceTool, 'name' | 'description'> & {
        parameters: Schema;
        run(
            params: Readonly<{
                input: ReturnType<typeof mapSchemaToShape<Schema>>['runtimeType'];
                context: VoiceToolContext;
            }>,
        ): Promise<VoiceToolResult>;
    }
>): VoiceTool {
    const inputShape = mapSchemaToShape(parameters);
    return {
        ...tool,
        parameters,
        async run({input, context}) {
            assertValidShape(input, inputShape);
            return await run({
                input,
                context,
            });
        },
    };
}

/** Spoken replies only need the gist, and long text slows the realtime model down. */
const maxSpokenTextLength = 1500;

function truncate(text: string) {
    return text.length > maxSpokenTextLength ? `${text.slice(0, maxSpokenTextLength)}…` : text;
}

/** A thread as the realtime model sees it: names it can say aloud, no paths. */
export function describeThread(thread: Readonly<Thread>) {
    return {
        ...selectFrom(thread, {
            id: true,
            title: true,
            status: true,
            isAskingQuestion: true,
            hasUnreadReply: true,
        }),
        repo: basename(thread.repoPath),
        branch: thread.worktreeBranch || '',
        minutesSinceUpdate: Math.round(
            convertDuration(
                {
                    milliseconds: Date.now() - thread.updatedAt,
                },
                {
                    minutes: true,
                },
            ).minutes,
        ),
    };
}

/** The item kinds `read_thread` returns: the conversation, without the agent's activity. */
const conversationItemKinds = [
    ThreadItemKind.UserMessage,
    ThreadItemKind.AssistantMessage,
    ThreadItemKind.Notice,
    ThreadItemKind.QuestionAnswer,
];

const threadIdSchema = {
    type: 'string',
    description: "The thread's id, from list_threads.",
} as const;

async function findThreadTitle({
    context,
    threadId,
}: Readonly<{
    context: VoiceToolContext;
    threadId: string;
}>) {
    return (
        await context.calls.readThread({
            threadId,
        })
    ).thread.title;
}

/** What the realtime model is told about its job, before the briefing on the current threads. */
export const voiceInstructions = [
    'You are the voice control for Agent Storm, an app that runs AI coding agents (Claude and Codex) in chat threads, each working in a code repository.',
    'The user talks to you through headphones while they work. Keep every reply to one or two short spoken sentences. Never read ids, file paths, or code aloud: name threads by their title.',
    "You don't write code yourself. You relay the user's requests to threads, and report what threads are doing.",
    "To act on a thread, find it by title with list_threads, since the briefing below goes stale. Read it with read_thread when you need context. Send work with send_to_thread, passing the user's request on as clear written instructions that keep their intent, without adding requirements of your own.",
    'Start new work with create_thread only when the user asks for a new thread. Pick its repo from list_folders.',
    'Before archive_thread, interrupt_thread, or resolve_request, say what you are about to do and wait for the user to confirm, unless they already asked for exactly that. A thread whose status is needsApproval waits on a request; read it to learn what it asks.',
    'A system message starting with "Update:" says a thread changed. Tell the user about it in one short sentence.',
    'When the user wants to look at a thread, call open_thread to show it on their screen.',
].join(' ');

export const voiceTools: ReadonlyArray<VoiceTool> = [
    defineVoiceTool({
        name: 'list_threads',
        description:
            "Lists Agent Storm's chat threads that aren't archived, latest activity first, with each one's status.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {},
        },
        async run({context}) {
            const {threads} = await context.calls.listThreads({});
            return {
                output: {
                    threads: threads.map(describeThread),
                },
                summary: 'Checked the thread list',
                threadId: '',
            };
        },
    }),
    defineVoiceTool({
        name: 'list_folders',
        description:
            "Lists the repos in Agent Storm's sidebar, with their worktrees, for picking where create_thread starts a thread.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {},
        },
        async run({context}) {
            const folders = await context.listFolders();
            return {
                output: {
                    folders: folders.map((folder) => {
                        return {
                            ...selectFrom(folder, {
                                path: true,
                                name: true,
                                branch: true,
                            }),
                            parentRepoPath: folder.parentRepoPath || '',
                        };
                    }),
                },
                summary: 'Checked the folder list',
                threadId: '',
            };
        },
    }),
    defineVoiceTool({
        name: 'read_thread',
        description:
            "Reads a thread's latest messages and any requests it has waiting on the user, such as approvals or questions.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
                lastMessageCount: {
                    type: 'integer',
                    minimum: 1,
                    description: 'How many of the latest messages to return. Defaults to 4.',
                },
            },
            required: [
                'threadId',
            ],
        },
        async run({input, context}) {
            const {thread, items, requests} = await context.calls.readThread({
                threadId: input.threadId,
            });
            return {
                output: {
                    thread: describeThread(thread),
                    messages: items
                        .filter((item) => conversationItemKinds.includes(item.kind))
                        .slice(-(input.lastMessageCount || 4))
                        .map((item) => {
                            return {
                                kind: item.kind,
                                text: truncate(item.text || item.title),
                            };
                        }),
                    pendingRequests: requests.map((request) => {
                        return {
                            ...selectFrom(request, {
                                id: true,
                                kind: true,
                                title: true,
                                reason: true,
                            }),
                            detail: truncate(request.detail),
                            questions: request.questions.map((question) => {
                                return {
                                    question: question.question,
                                    options: question.options.map((option) => option.label),
                                };
                            }),
                        };
                    }),
                },
                summary: `Read “${thread.title}”`,
                threadId: thread.id,
            };
        },
    }),
    defineVoiceTool({
        name: 'send_to_thread',
        description:
            "Sends a message to a thread, as if the user typed it. Starts the thread's agent if it isn't running.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
                text: {
                    type: 'string',
                },
            },
            required: [
                'threadId',
                'text',
            ],
        },
        async run({input, context}) {
            const title = await findThreadTitle({
                context,
                threadId: input.threadId,
            });
            await context.calls.sendMessage(input);
            return {
                output: {
                    ok: true,
                },
                summary: `Sent to “${title}”: ${input.text}`,
                threadId: input.threadId,
            };
        },
    }),
    defineVoiceTool({
        name: 'create_thread',
        description:
            "Starts a new thread in a repo and sends it its first message, with the repo's default model.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                repoPath: {
                    type: 'string',
                    description: "A folder's path, from list_folders.",
                },
                text: {
                    type: 'string',
                    description: "The new thread's first message.",
                },
                isInWorktree: {
                    type: 'boolean',
                    description:
                        'Moves the new thread into a new git worktree of the repo before sending its first message.',
                },
            },
            required: [
                'repoPath',
                'text',
            ],
        },
        async run({input, context}) {
            const folders = await context.listFolders();
            const folder = folders.find((info) => info.path === input.repoPath);
            if (!folder) {
                throw new Error(`${input.repoPath} isn't a folder in Agent Storm's sidebar.`);
            }
            const modelDefaults = readModelDefaults(await context.loadSettings());
            const modelDefault = modelDefaults.folders[folder.parentRepoPath || folder.path] ||
                modelDefaults.global || {
                    provider: AiProvider.Claude,
                    model: '',
                    effort: undefined,
                };
            const {thread} = await context.calls.createThread({
                id: undefined,
                repoPath: folder.path,
                provider: modelDefault.provider,
                model: modelDefault.model,
                effort: modelDefault.effort,
                speedTier: undefined,
                /** New threads from the composer start in this mode too. */
                runtimeMode: RuntimeMode.FullAccess,
                text: input.text,
                title: undefined,
                isInWorktree: !!input.isInWorktree,
                isStartAwaited: true,
                parentThreadId: undefined,
                isSidebarThread: true,
            });
            return {
                output: {
                    thread: describeThread(thread),
                },
                summary: `Started a thread in ${folder.name}: ${input.text}`,
                threadId: thread.id,
            };
        },
    }),
    defineVoiceTool({
        name: 'interrupt_thread',
        description:
            "Stops a thread's running turn, declining every request it has waiting on the user.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
            },
            required: [
                'threadId',
            ],
        },
        async run({input, context}) {
            const title = await findThreadTitle({
                context,
                threadId: input.threadId,
            });
            await context.calls.interrupt(input);
            return {
                output: {
                    ok: true,
                },
                summary: `Stopped “${title}”`,
                threadId: input.threadId,
            };
        },
    }),
    defineVoiceTool({
        name: 'resolve_request',
        description:
            "Answers a request a thread has waiting on the user, from read_thread's pendingRequests: approves or declines it, or answers its questions.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
                requestId: {
                    type: 'string',
                    description: "The request's id, from read_thread.",
                },
                decision: {
                    type: 'string',
                    /**
                     * Approving for the whole session stays a click in the app, so nothing read
                     * aloud to the voice model can widen what a thread may do.
                     */
                    enum: getEnumValues(ApprovalDecision).filter((decision) => {
                        return decision !== ApprovalDecision.ApproveForSession;
                    }),
                    description: 'Answering questions is an approve.',
                },
                answers: {
                    type: 'array',
                    items: {
                        type: 'string',
                    },
                    description:
                        "One answer per question, in order, for a question request: an option's label, or the user's own words.",
                },
            },
            required: [
                'threadId',
                'requestId',
                'decision',
            ],
        },
        async run({input, context}) {
            const title = await findThreadTitle({
                context,
                threadId: input.threadId,
            });
            await context.calls.resolveRequest({
                requestId: input.requestId,
                decision: input.decision,
                answers: input.answers || [],
            });
            return {
                output: {
                    ok: true,
                },
                summary: `Answered “${title}”: ${[
                    input.decision,
                    ...(input.answers || []),
                ].join(', ')}`,
                threadId: input.threadId,
            };
        },
    }),
    defineVoiceTool({
        name: 'open_thread',
        description: "Shows a thread on the user's screen, in Build.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
            },
            required: [
                'threadId',
            ],
        },
        async run({input, context}) {
            const title = await findThreadTitle({
                context,
                threadId: input.threadId,
            });
            context.openThread(input.threadId);
            return {
                output: {
                    ok: true,
                },
                summary: `Opened “${title}”`,
                threadId: input.threadId,
            };
        },
    }),
    defineVoiceTool({
        name: 'archive_thread',
        description:
            "Stops a thread and hides it from Agent Storm's sidebar. Its worktree, if any, stays.",
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                threadId: threadIdSchema,
            },
            required: [
                'threadId',
            ],
        },
        async run({input, context}) {
            const title = await findThreadTitle({
                context,
                threadId: input.threadId,
            });
            await context.calls.archiveThread({
                threadId: input.threadId,
                deleteWorktree: false,
            });
            return {
                output: {
                    ok: true,
                },
                summary: `Archived “${title}”`,
                threadId: input.threadId,
            };
        },
    }),
];
