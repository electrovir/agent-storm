import {definePluginApi} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

export const buildV2PluginId = 'build-v2';

/** The agent CLI a thread talks to. */
export enum AiProvider {
    Claude = 'claude',
    Codex = 'codex',
}

export const providerLabels: Record<AiProvider, string> = {
    [AiProvider.Claude]: 'Claude',
    [AiProvider.Codex]: 'Codex',
};

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
        /** Starts a thread in the checkout and sends its first message. */
        createThread: {
            requestShape: defineShape({
                repoPath: '',
                provider: enumShape(AiProvider),
                model: '',
                effort: nullableShape(enumShape(ReasoningEffort)),
                speedTier: nullableShape(''),
                runtimeMode: enumShape(RuntimeMode),
                text: '',
                /**
                 * Moves the thread into a new worktree, as `moveToWorktree` does, before sending
                 * `text`. For a Claude thread in a repo with an `open-worktree` skill, sends `text`
                 * to that skill from the checkout instead, and the skill makes the worktree.
                 */
                isInWorktree: false,
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
                /** One answer per question, in order, when approving a `Question` request. */
                answers: [
                    '',
                ],
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
        /** Clears the thread's `hasUnreadReply` without moving it in the sidebar's order. */
        markThreadRead: {
            requestShape: threadRequestShape,
            responseShape: okResponseShape,
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
