import {definePluginApi} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

export const buildV2PluginId = 'build-v2';

/** The agent CLI a thread talks to. */
export enum AiProvider {
    Claude = 'claude',
    Codex = 'codex',
}

/** How much thinking a model does before it answers. */
export enum ReasoningEffort {
    Low = 'low',
    Medium = 'medium',
    High = 'high',
    ExtraHigh = 'xhigh',
    Max = 'max',
    Ultra = 'ultra',
}

/** How much a thread's agent may do without asking the user first. */
export enum RuntimeMode {
    /** Asks before commands and file changes. */
    Supervised = 'supervised',
    /** Makes file edits without asking, and asks before everything else. */
    AutoAcceptEdits = 'autoAcceptEdits',
    /** The provider's own reviewer approves routine actions and asks about the rest. */
    Auto = 'auto',
    /** Runs commands and edits without asking. */
    FullAccess = 'fullAccess',
}

export enum ThreadStatus {
    Idle = 'idle',
    Running = 'running',
    /** Paused on at least one pending request the user must answer. */
    NeedsApproval = 'needsApproval',
    /** The provider's process failed. The next message starts it again. */
    Failed = 'failed',
}

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
    runtimeMode: enumShape(RuntimeMode),
    title: '',
    status: enumShape(ThreadStatus),
    /** Epoch milliseconds. */
    createdAt: 0,
    /** Epoch milliseconds of the thread's latest activity, which orders the sidebar. */
    updatedAt: 0,
});

export type Thread = typeof threadShape.runtimeType;

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
    /** Position in the thread's timeline. */
    order: 0,
    /** Epoch milliseconds. */
    createdAt: 0,
});

export type ThreadItem = typeof threadItemShape.runtimeType;

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
    /** Empty when the model has no effort setting. */
    supportedEfforts: [
        enumShape(ReasoningEffort),
    ],
    /** The effort the model uses when a thread sets none, when the provider says. */
    defaultEffort: nullableShape(enumShape(ReasoningEffort)),
});

export type ProviderModel = typeof providerModelShape.runtimeType;

const threadRequestShape = defineShape({
    threadId: '',
});

const okResponseShape = defineShape({
    ok: true,
});

const threadResponseShape = defineShape({
    thread: threadShape,
});

/** The Build V2 plugin's calls into its server part, and the events it pushes back. */
export const buildV2Api = definePluginApi({
    pluginId: buildV2PluginId,
    calls: {
        /** Every thread that isn't archived, latest activity first. */
        listThreads: {
            requestShape: defineShape({}),
            responseShape: defineShape({
                threads: [
                    threadShape,
                ],
            }),
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
        /** Starts a thread in the checkout and sends its first message. */
        createThread: {
            requestShape: defineShape({
                repoPath: '',
                provider: enumShape(AiProvider),
                model: '',
                effort: nullableShape(enumShape(ReasoningEffort)),
                runtimeMode: enumShape(RuntimeMode),
                text: '',
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
        resolveRequest: {
            requestShape: defineShape({
                requestId: '',
                decision: enumShape(ApprovalDecision),
            }),
            responseShape: okResponseShape,
        },
        /**
         * Creates a worktree of the thread's checkout, runs the post-worktree command there, and
         * resumes the thread in it. With a `requestId`, declines that request first and tells the
         * provider to redo the work in the worktree.
         */
        moveToWorktree: {
            requestShape: defineShape({
                threadId: '',
                requestId: nullableShape(''),
            }),
            responseShape: threadResponseShape,
        },
        /**
         * Uses `model` and `effort` from the thread's next message on. A missing `effort` is the
         * model's default. Fails while the thread runs.
         */
        setThreadModel: {
            requestShape: defineShape({
                threadId: '',
                model: '',
                effort: nullableShape(enumShape(ReasoningEffort)),
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
        /** Stops the thread and hides it from the sidebar. */
        archiveThread: {
            requestShape: threadRequestShape,
            responseShape: okResponseShape,
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
    },
});
