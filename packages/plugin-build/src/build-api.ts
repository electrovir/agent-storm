// cspell:words claudeai, unpushed
import {
    AiProvider,
    buildPluginId,
    definePluginApi,
    ReasoningEffort,
    RuntimeMode,
    ThreadOrigin,
    ThreadStatus,
    ViewerFileStatus,
    ViewerFileType,
} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape, optionalShape} from 'object-shape-tester';

export {
    aiChatPaneId,
    AiProvider,
    buildPluginId,
    ReasoningEffort,
    RuntimeMode,
    ThreadOrigin,
    ThreadStatus,
} from '@agent-storm/common';

/** An AI Chat tab's label, and a side chat's title until it gets a generated one. */
export const aiChatTabLabel = 'AI Chat';

/** Whether a side chat's title is short enough to name its tab. */
export function isTabName(title: string) {
    return !!title.trim() && title.trim().split(/\s+/).length <= 2;
}

/** The pane group scope of a thread's own tabs and terminals. */
export function toThreadScope(threadId: string) {
    return `build:${threadId}`;
}

export const providerLabels: Record<AiProvider, string> = {
    [AiProvider.Claude]: 'Claude',
    [AiProvider.Codex]: 'Codex',
};

/** What one entry in a thread's timeline shows. */
export enum ThreadItemKind {
    UserMessage = 'userMessage',
    AssistantMessage = 'assistantMessage',
    Reasoning = 'reasoning',
    Command = 'command',
    FileChange = 'fileChange',
    /** Any other tool call (MCP, web search, sub-agents). */
    ToolCall = 'toolCall',
    Plan = 'plan',
    /** A note from the app itself, such as a move to a worktree or a provider error. */
    Notice = 'notice',
    /** The user's answers to questions the agent asked, each under its question. */
    QuestionAnswer = 'questionAnswer',
}

export enum ThreadItemStatus {
    InProgress = 'inProgress',
    Completed = 'completed',
    Failed = 'failed',
    Declined = 'declined',
}

/** What a pending request asks the user to allow. */
export enum ApprovalKind {
    Command = 'command',
    FileChange = 'fileChange',
    /** Any other tool or permission the provider asks for. */
    Permission = 'permission',
    /** The agent asks the user to pick from options or type their own answer. */
    Question = 'question',
}

export enum ApprovalDecision {
    Approve = 'approve',
    /** Approves this request and every later one like it for the rest of the session. */
    ApproveForSession = 'approveForSession',
    Decline = 'decline',
}

export const threadShape = defineShape({
    id: '',
    /** The checkout the thread belongs to, which groups it in the sidebar. */
    repoPath: '',
    /** Where the provider runs: `repoPath`, or the worktree the thread moved to. */
    cwd: '',
    /** The worktree's branch once the thread has moved to one. */
    worktreeBranch: nullableShape(''),
    provider: enumShape(AiProvider),
    /** Empty for the provider's default model. */
    model: '',
    /** Unset for the model's default effort. */
    effort: nullableShape(enumShape(ReasoningEffort)),
    /** The id of the model's faster service tier the thread uses. Unset for standard speed. */
    speedTier: nullableShape(''),
    runtimeMode: enumShape(RuntimeMode),
    title: '',
    status: enumShape(ThreadStatus),
    /** The agent finished a reply since the thread was last on screen. */
    hasUnreadReply: false,
    /** The user flagged the thread as a priority in the sidebar. */
    isPriority: false,
    /**
     * Every request the thread waits on is a question for the user rather than an action to
     * approve.
     */
    isAskingQuestion: false,
    /** Background tasks, such as sub-agents, the agent still waits on after its reply ended. */
    backgroundTaskCount: 0,
    origin: enumShape(ThreadOrigin),
    /** The PR a `Review` or `Watch` thread works on. */
    prUrl: nullableShape(''),
    /** The thread whose tabs hold a `SideChat` thread. */
    parentThreadId: nullableShape(''),
    /** Messages the user sent in the thread. */
    userMessageCount: 0,
    /**
     * Epoch milliseconds of the user's latest message, which orders threads within their folder.
     * The thread's creation time until it has one.
     */
    lastUserMessageAt: 0,
    /** Epoch milliseconds. */
    createdAt: 0,
    /** Epoch milliseconds of the thread's latest activity, which orders the sidebar. */
    updatedAt: 0,
});

export type Thread = typeof threadShape.runtimeType;

/** Statuses of a thread that's mid-turn. */
export const busyThreadStatuses: Readonly<Record<ThreadStatus, boolean>> = {
    [ThreadStatus.Idle]: false,
    [ThreadStatus.Running]: true,
    [ThreadStatus.NeedsApproval]: true,
    [ThreadStatus.Failed]: false,
};

export const threadItemShape = defineShape({
    id: '',
    threadId: '',
    /** Groups the items one user message caused. */
    turnId: '',
    kind: enumShape(ThreadItemKind),
    status: enumShape(ThreadItemStatus),
    /** The item's one-line label: the command line, the file path, the tool name. */
    title: '',
    /**
     * The item's body: message Markdown, reasoning text, command output, a unified diff, or a
     * tool's input and result.
     */
    text: '',
    /** Absolute paths of the images the item shows, such as the screenshots a tool returned. */
    imagePaths: [
        '',
    ],
    /** Position in the thread's timeline. */
    order: 0,
    /** Epoch milliseconds. */
    createdAt: 0,
    /** Epoch milliseconds of the item's latest saved change. Streamed text doesn't change it. */
    updatedAt: 0,
});

export type ThreadItem = typeof threadItemShape.runtimeType;

export const userQuestionShape = defineShape({
    /** A few words naming the question. */
    header: '',
    question: '',
    /** Lets the user pick any number of options instead of exactly one. */
    isMultiSelect: false,
    options: [
        {
            label: '',
            description: '',
            /** Markdown to show under the option, such as a mockup or code. Empty for none. */
            preview: '',
        },
    ],
});

export type UserQuestion = typeof userQuestionShape.runtimeType;

export const approvalRequestShape = defineShape({
    id: '',
    threadId: '',
    kind: enumShape(ApprovalKind),
    /** What the provider wants to do, in one line: the command, the file, the tool name. */
    title: '',
    /** The full command, the unified diff, or the tool's input. */
    detail: '',
    /** Why the provider says it needs this, when it says. */
    reason: '',
    /** What a `Question` request asks. Empty for every other kind. */
    questions: [
        userQuestionShape,
    ],
    /** Epoch milliseconds. */
    createdAt: 0,
});

export type ApprovalRequest = typeof approvalRequestShape.runtimeType;

export const providerModelShape = defineShape({
    /** What a thread's `model` holds to use this model. */
    id: '',
    name: '',
    description: '',
    /** The model a thread with an empty `model` uses. */
    isDefault: false,
    /** An older version, which the picker hides behind "Show older models" until searched for. */
    isLegacy: false,
    /** Empty when the model has no effort setting. */
    supportedEfforts: [
        enumShape(ReasoningEffort),
    ],
    /** The effort the model uses when a thread sets none, when the provider says. */
    defaultEffort: nullableShape(enumShape(ReasoningEffort)),
    /** The faster service tiers the model offers besides standard speed. */
    speedTiers: [
        {
            /** What a thread's `speedTier` holds to use this tier. */
            id: '',
            name: '',
        },
    ],
});

export type ProviderModel = typeof providerModelShape.runtimeType;

/** What typing a composer command's name does. */
export enum ComposerCommandKind {
    /** Runs as `/name` at the start of a message. */
    Command = 'command',
    /** Loads the skill's instructions, from `$name` anywhere in a message. */
    Skill = 'skill',
}

/** Where a composer command or skill is defined. */
export enum ComposerCommandSource {
    /** Ships with the provider's CLI. */
    BuiltIn = 'builtIn',
    /** Checked into the thread's checkout. */
    Repo = 'repo',
    /** Added by the user to their own config folder. */
    Personal = 'personal',
    /** Synced down from the user's provider account, such as the skills enabled on claude.ai. */
    Synced = 'synced',
    /** From an installed plugin. */
    Plugin = 'plugin',
    /** Anything else, such as an MCP server's prompt. */
    Other = 'other',
}

export const composerCommandShape = defineShape({
    /** What follows `/` or `$`. */
    name: '',
    description: '',
    /** What the command takes after its name, such as `<file>`. Empty for nothing. */
    argumentHint: '',
    kind: enumShape(ComposerCommandKind),
    source: enumShape(ComposerCommandSource),
});

export type ComposerCommand = typeof composerCommandShape.runtimeType;

/** Whether an MCP server's tools reach the agent. */
export enum McpServerState {
    Connected = 'connected',
    /** Still connecting. */
    Pending = 'pending',
    Failed = 'failed',
    /** The user has to sign in to the server before it connects. */
    NeedsAuth = 'needsAuth',
    Disabled = 'disabled',
}

export const mcpServerShape = defineShape({
    name: '',
    state: enumShape(McpServerState),
    /** Why the server failed to connect. Empty otherwise. */
    error: '',
    /** Where the server is configured, such as `user`, `project`, or `claudeai`. */
    scope: '',
    /** The tools the server gives the agent while connected. */
    toolCount: 0,
});

export type McpServer = typeof mcpServerShape.runtimeType;

/** Whether the chat can list and toggle the MCP servers of each provider's threads. */
export const mcpControlProviders: Readonly<Record<AiProvider, boolean>> = {
    [AiProvider.Claude]: true,
    [AiProvider.Codex]: false,
};

const mcpServersResponseShape = defineShape({
    servers: [
        mcpServerShape,
    ],
    /** Why the requested change failed, which leaves `servers` as they were. Empty on success. */
    error: '',
});

export const threadRequestShape = defineShape({
    threadId: '',
});

const okResponseShape = defineShape({
    ok: true,
});

const threadResponseShape = defineShape({
    thread: threadShape,
});

/** The Build plugin's calls into its server part, and the events it pushes back. */
export const buildApi = definePluginApi({
    pluginId: buildPluginId,
    calls: {
        /** Every thread that isn't archived, latest activity first. */
        listThreads: {
            requestShape: defineShape({}),
            responseShape: defineShape({
                threads: [
                    threadShape,
                ],
                /** Every `ThreadOrigin.SideChat` thread that isn't archived. */
                sideChats: [
                    threadShape,
                ],
                /** Every thread that isn't archived and isn't a `User` or side chat thread. */
                paneThreads: [
                    threadShape,
                ],
                /** Each repo's latest thread activity, archived threads included. */
                repoActivity: [
                    {
                        repoPath: '',
                        /** Epoch milliseconds. */
                        updatedAt: 0,
                    },
                ],
            }),
        },
        /** Every archived thread, latest activity first. */
        listArchivedThreads: {
            requestShape: defineShape({}),
            responseShape: defineShape({
                threads: [
                    threadShape,
                ],
            }),
        },
        /**
         * Brings an archived thread back to the sidebar. When archiving deleted its worktree, first
         * checks the thread's branch out into a new worktree.
         */
        unarchiveThread: {
            requestShape: threadRequestShape,
            responseShape: threadResponseShape,
        },
        /** The models the provider offers, as its CLI lists them. */
        listModels: {
            requestShape: defineShape({
                provider: enumShape(AiProvider),
            }),
            responseShape: defineShape({
                models: [
                    providerModelShape,
                ],
            }),
        },
        /** The commands and skills a thread of `provider` running in `cwd` can use. */
        listCommands: {
            requestShape: defineShape({
                provider: enumShape(AiProvider),
                cwd: '',
            }),
            responseShape: defineShape({
                commands: [
                    composerCommandShape,
                ],
            }),
        },
        /**
         * The MCP servers the thread's agent sees, from its running session. Without one, from a
         * short-lived session in the thread's folder that waits for its servers to connect.
         */
        listMcpServers: {
            requestShape: defineShape({
                threadId: '',
                /**
                 * Also connects servers added to the config since the running session started,
                 * which costs starting a short-lived CLI process.
                 */
                isNewServerLoadEnabled: false,
            }),
            responseShape: mcpServersResponseShape,
        },
        /**
         * Turns an MCP server on or off for the thread's running session. Claude Code also saves it
         * for the folder, so later sessions there start with it the same way.
         */
        setMcpServerEnabled: {
            requestShape: defineShape({
                threadId: '',
                serverName: '',
                isEnabled: false,
            }),
            responseShape: mcpServersResponseShape,
        },
        /** Connects an MCP server again, such as after it failed or the user signed in to it. */
        reconnectMcpServer: {
            requestShape: defineShape({
                threadId: '',
                serverName: '',
            }),
            responseShape: mcpServersResponseShape,
        },
        /**
         * Starts signing in to an MCP server. The user finishes at `authUrl`, then the session that
         * started the sign-in connects the server itself. `authUrl` is empty when the server needed
         * no sign-in.
         */
        signInMcpServer: {
            requestShape: defineShape({
                threadId: '',
                serverName: '',
            }),
            responseShape: defineShape({
                servers: [
                    mcpServerShape,
                ],
                /** Why the sign-in couldn't start. Empty on success. */
                error: '',
                authUrl: '',
                /**
                 * Whether the sign-in page redirects to a localhost address on the server's
                 * machine, which a browser on another device can't reach. Passing that address to
                 * `submitMcpSignInCallback` finishes the sign-in instead.
                 */
                isCallbackExpected: false,
            }),
        },
        /**
         * Finishes an MCP server's sign-in with the localhost address its sign-in page redirected
         * to.
         */
        submitMcpSignInCallback: {
            requestShape: defineShape({
                threadId: '',
                serverName: '',
                callbackUrl: '',
            }),
            responseShape: mcpServersResponseShape,
        },
        /** Starts a thread in the checkout and sends its first message. */
        createThread: {
            requestShape: defineShape({
                /**
                 * Lets the caller show the thread before the reply arrives. The server picks one
                 * when unset.
                 */
                id: nullableShape(''),
                repoPath: '',
                provider: enumShape(AiProvider),
                model: '',
                effort: nullableShape(enumShape(ReasoningEffort)),
                speedTier: nullableShape(''),
                runtimeMode: enumShape(RuntimeMode),
                text: '',
                /**
                 * Kept as the thread's title, like a rename, instead of one generated from `text`.
                 * Blank to generate one.
                 */
                title: nullableShape(''),
                /**
                 * Moves the thread into a new worktree, as `moveToWorktree` does, before sending
                 * `text`. For a Claude thread in a main checkout with an `open-worktree` skill,
                 * sends `text` to that skill from the checkout instead, and the skill makes the
                 * worktree.
                 */
                isInWorktree: false,
                /**
                 * Waits for the worktree and the provider's start before replying, so the returned
                 * thread shows whether starting failed. Otherwise replies as soon as the thread and
                 * its first message are saved.
                 */
                isStartAwaited: nullableShape(false),
                /**
                 * Starts a `ThreadOrigin.SideChat` thread in this thread's tabs instead of a
                 * `ThreadOrigin.User` one.
                 */
                parentThreadId: nullableShape(''),
                /**
                 * Shows the thread in the sidebar as a `ThreadOrigin.User` one. Otherwise, without
                 * `parentThreadId`, it's a hidden `ThreadOrigin.PaneChat` one.
                 */
                isSidebarThread: nullableShape(false),
                /** Starts the thread flagged as a priority, as `setThreadPriority` would. */
                isPriority: nullableShape(false),
            }),
            responseShape: threadResponseShape,
        },
        readThread: {
            requestShape: threadRequestShape,
            responseShape: defineShape({
                thread: threadShape,
                items: [
                    threadItemShape,
                ],
                requests: [
                    approvalRequestShape,
                ],
            }),
        },
        /** Saves a file dropped onto a chat, so a message can name its path for the agent to read. */
        uploadFile: {
            requestShape: defineShape({
                filename: '',
                dataBase64: '',
            }),
            responseShape: defineShape({
                path: '',
            }),
        },
        /** Reads back a file saved by `uploadFile`, to preview it in a sent message. */
        readUpload: {
            requestShape: defineShape({
                path: '',
            }),
            responseShape: defineShape({
                dataBase64: '',
            }),
        },
        /**
         * Reads an image file for the chat to show, from any absolute path the user's account can
         * read. Rejects anything but an image file.
         */
        readImage: {
            requestShape: defineShape({
                path: '',
            }),
            responseShape: defineShape({
                mimeType: '',
                dataBase64: '',
            }),
        },
        /** Sends a message. Starts the provider again first if it isn't running. */
        sendMessage: {
            requestShape: defineShape({
                threadId: '',
                text: '',
            }),
            responseShape: okResponseShape,
        },
        /** Stops the running turn, declining every pending request. */
        interrupt: {
            requestShape: threadRequestShape,
            responseShape: okResponseShape,
        },
        /**
         * Stops the thread's AI process, ending any running turn, so the thread's next message
         * starts a new one.
         */
        restartThread: {
            requestShape: threadRequestShape,
            responseShape: okResponseShape,
        },
        resolveRequest: {
            requestShape: defineShape({
                requestId: '',
                decision: enumShape(ApprovalDecision),
                /** One answer per question, in order, when approving a `Question` request. */
                answers: [
                    '',
                ],
            }),
            responseShape: okResponseShape,
        },
        /**
         * Creates a worktree of the thread's checkout, runs the post-worktree command there, and
         * resumes the thread in it.
         */
        moveToWorktree: {
            requestShape: defineShape({
                threadId: '',
                /**
                 * A worktree of the same repo to branch from instead of the thread's checkout, so
                 * the new branch stacks on that worktree's branch.
                 */
                baseFolder: nullableShape(''),
            }),
            responseShape: threadResponseShape,
        },
        /**
         * Stops the thread's session and resumes it in another folder from the sidebar, which can
         * belong to a different repo.
         */
        moveToFolder: {
            requestShape: defineShape({
                threadId: '',
                folder: '',
            }),
            responseShape: threadResponseShape,
        },
        /**
         * Uses `provider`, `model`, `effort`, and `speedTier` from the thread's next message on. A
         * missing `effort` is the model's default and a missing `speedTier` is standard speed. A
         * new provider gets the thread's earlier messages with that next message. Fails while the
         * thread runs.
         */
        setThreadModel: {
            requestShape: defineShape({
                threadId: '',
                provider: enumShape(AiProvider),
                model: '',
                effort: nullableShape(enumShape(ReasoningEffort)),
                speedTier: nullableShape(''),
            }),
            responseShape: threadResponseShape,
        },
        /**
         * Claude uses the new mode right away, even mid-turn. Codex uses it from the thread's next
         * message on.
         */
        setThreadRuntimeMode: {
            requestShape: defineShape({
                threadId: '',
                runtimeMode: enumShape(RuntimeMode),
            }),
            responseShape: threadResponseShape,
        },
        renameThread: {
            requestShape: defineShape({
                threadId: '',
                title: '',
            }),
            responseShape: threadResponseShape,
        },
        /** Sets the thread's `isPriority` without moving it in the sidebar's order. */
        setThreadPriority: {
            requestShape: defineShape({
                threadId: '',
                isPriority: false,
            }),
            responseShape: threadResponseShape,
        },
        /** Clears the thread's `hasUnreadReply` without moving it in the sidebar's order. */
        markThreadRead: {
            requestShape: threadRequestShape,
            responseShape: okResponseShape,
        },
        /** Sets the thread's `hasUnreadReply` without moving it in the sidebar's order. */
        markThreadUnread: {
            requestShape: threadRequestShape,
            responseShape: threadResponseShape,
        },
        /** What deleting the thread's worktree would lose, read from git at the time of the call. */
        readWorktreeChanges: {
            requestShape: threadRequestShape,
            responseShape: defineShape({
                hasUncommittedChanges: false,
                /** Commits on the branch that no other branch or remote has. */
                branchCommitCount: 0,
                /** Commits on the branch that no remote has. */
                unpushedCommitCount: 0,
            }),
        },
        /** Stops the thread and hides it from the sidebar. */
        archiveThread: {
            requestShape: defineShape({
                threadId: '',
                /**
                 * Also deletes the thread's worktree folder, uncommitted changes included, when the
                 * thread made that worktree itself and no other thread works in it. Its branch
                 * stays.
                 */
                deleteWorktree: optionalShape(false, {
                    alsoUndefined: true,
                }),
            }),
            responseShape: okResponseShape,
        },
        /**
         * Starts a voice call with OpenAI's realtime model, which controls Agent Storm through its
         * own tools. Takes the browser's WebRTC offer and returns the answer that connects its
         * audio straight to OpenAI. The server keeps its own connection to the call to run the
         * tools.
         */
        startVoiceCall: {
            requestShape: defineShape({
                sdpOffer: '',
            }),
            responseShape: defineShape({
                callId: '',
                sdpAnswer: '',
            }),
        },
        /** Hangs up a voice call from `startVoiceCall`. Does nothing for a call that already ended. */
        endVoiceCall: {
            requestShape: defineShape({
                callId: '',
            }),
            responseShape: okResponseShape,
        },
        /** Reads one file for a Viewer tab, or says why it can't be shown. */
        readViewerFile: {
            requestShape: defineShape({
                /** The tab's folder, which a relative `path` resolves against. */
                folder: '',
                /** Relative to `folder`, absolute, or starting with `~/`. */
                path: '',
                /** The `modifiedAtMs` the caller already shows. 0 asks for the content regardless. */
                knownModifiedAtMs: 0,
            }),
            responseShape: defineShape({
                status: enumShape(ViewerFileStatus),
                resolvedPath: '',
                fileType: nullableShape(enumShape(ViewerFileType)),
                mimeType: '',
                /** The file's modified time in whole milliseconds. 0 when the file can't be read. */
                modifiedAtMs: 0,
                /** The file's bytes, base64-encoded. Empty unless `status` is `Loaded`. */
                contentBase64: '',
            }),
        },
    },
    events: {
        /** A thread was created, renamed, or changed status or folder. */
        threadChanged: threadShape,
        threadArchived: threadRequestShape,
        /** Items were added or replaced in a thread. */
        itemsChanged: defineShape({
            threadId: '',
            items: [
                threadItemShape,
            ],
        }),
        /** Streamed text to append to an in-progress item's `text`. */
        itemDelta: defineShape({
            threadId: '',
            itemId: '',
            delta: '',
        }),
        /** A thread's full set of pending requests, after any was added or answered. */
        requestsChanged: defineShape({
            threadId: '',
            requests: [
                approvalRequestShape,
            ],
        }),
        /** A voice call's model ran one of its tools. */
        voiceToolRun: defineShape({
            callId: '',
            toolName: '',
            /** What the tool did, for the user to read. */
            summary: '',
            /** The thread the tool acted on. Empty for none. */
            threadId: '',
            /** Why the tool failed. Empty on success. */
            error: '',
        }),
        /** A voice call's model asked the window that started the call to show a thread. */
        voiceOpenThread: defineShape({
            callId: '',
            threadId: '',
        }),
        /** A thread's agent asked to show a file in a Viewer tab beside its chat. */
        showViewerFile: defineShape({
            threadId: '',
            /** Absolute. */
            path: '',
        }),
    },
});
