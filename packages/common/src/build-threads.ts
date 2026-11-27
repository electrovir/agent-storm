import {getEnumValues, type PartialWithUndefined} from '@augment-vir/common';
import {definePluginServerExportsKey} from './plugins.js';

export const buildPluginId = 'build';

/** Lives here so Build can open the Bots tab for a bot's thread without depending on it. */
export const botsPluginId = 'bots';

/**
 * The Review plugin's id, which is also its activity's and starts its route. Lives here so Build's
 * server can link to a PR's review without loading Review's UI.
 */
export const reviewActivityId = 'review';

/** The Review activity's route to the PR `owner/repoName#number`. */
export function toReviewPrPaths({
    owner,
    repoName,
    number,
}: Readonly<{
    owner: string;
    repoName: string;
    number: string;
}>) {
    return [
        reviewActivityId,
        owner,
        repoName,
        number,
    ];
}

/** The pane a tab shows a thread in, which a tab of another plugin's thread uses too. */
export const aiChatPaneId = 'ai-chat';

/** Who started a thread. Only {@link sidebarThreadOrigins} show in the sidebar and to agent tools. */
export enum ThreadOrigin {
    User = 'user',
    /** Runs a PR review for the Review plugin. */
    Review = 'review',
    /** Runs watch mode's passes for the Review plugin. */
    Watch = 'watch',
    /** An extra AI Chat tab in a thread's tabs. Its generated title names its tab. */
    SideChat = 'sideChat',
    /** An AI Chat tab outside Build's threads, such as in a Review or Build folder's tabs. */
    PaneChat = 'paneChat',
    /**
     * Agent-storm's self-improvement, which works on a copy of its own checkout while the user is
     * away.
     */
    SelfImprove = 'selfImprove',
    /** Runs a bot's AI work for the Bots plugin. */
    Bot = 'bot',
}

const isSidebarOrigin: Readonly<Record<ThreadOrigin, boolean>> = {
    [ThreadOrigin.User]: true,
    [ThreadOrigin.Review]: false,
    [ThreadOrigin.Watch]: false,
    [ThreadOrigin.SideChat]: false,
    [ThreadOrigin.PaneChat]: false,
    /** Its proposals wait for the user there, beside the checkout it improves. */
    [ThreadOrigin.SelfImprove]: true,
    /** Its thread shows in the bot's own tabs in the Bots tab. */
    [ThreadOrigin.Bot]: false,
};

/** The origins of the threads the sidebar lists. Any other thread shows only in a tab. */
export const sidebarThreadOrigins = getEnumValues(ThreadOrigin).filter((origin) => {
    return isSidebarOrigin[origin];
});

/** The origin of a thread started from an AI Chat tab. */
export function findNewThreadOrigin({
    parentThreadId,
    isSidebarThread,
}: Readonly<
    PartialWithUndefined<{
        parentThreadId: string | null;
        /** Set only by Build's new-thread composer and the agent tool that starts threads. */
        isSidebarThread: boolean | null;
    }>
>) {
    if (parentThreadId) {
        return ThreadOrigin.SideChat;
    }
    return isSidebarThread ? ThreadOrigin.User : ThreadOrigin.PaneChat;
}

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

/**
 * Picks a plugin's thread out of the ones it started: the newest one of `origin` in `cwd` that
 * isn't archived.
 */
export type PluginThreadTarget = Readonly<{
    cwd: string;
    /** Never `ThreadOrigin.User`: those threads are the user's. */
    origin: ThreadOrigin;
}>;

/** Same as {@link PluginThreadTarget} for several folders at once. */
export type PluginThreadsTarget = Readonly<{
    folders: ReadonlyArray<string>;
    /** Never `ThreadOrigin.User`: those threads are the user's. */
    origin: ThreadOrigin;
}>;

/** The part of a Build thread the plugins that run threads get to see. */
export type PluginThread = Readonly<{
    id: string;
    status: ThreadStatus;
    origin: ThreadOrigin;
}>;

/** What Build's server part gives the plugins that run their AI work as its threads. */
export type BuildServerExports = Readonly<{
    findPluginThread(target: PluginThreadTarget): Promise<PluginThread | undefined>;
    /**
     * Same as `findPluginThread` for each of `folders`, in their order, with one database query.
     * Use it for anything polled across many folders: every query waits in one line with the
     * queries that open a thread.
     */
    findPluginThreads(target: PluginThreadsTarget): Promise<(PluginThread | undefined)[]>;
    /**
     * Sends `text` to the target thread, or starts one when there's none. The origin's model
     * setting wins over the folder's default model, and moves an existing thread onto it too. A new
     * thread runs with full access, since nobody may be watching it to approve actions.
     */
    sendToPluginThread(
        params: PluginThreadTarget &
            Readonly<{
                text: string;
                /** The PR the thread works on, which its usage is logged against. */
                prUrl: string;
            }>,
    ): Promise<PluginThread>;
    /**
     * Shrinks the thread's context before its next message: Claude compacts the conversation. Does
     * nothing for Codex, which compacts on its own.
     */
    compactThread(threadId: string): Promise<void>;
    /**
     * Same as `sendToPluginThread`, except that it always starts a new thread, on the given model
     * and runtime mode rather than the origin's defaults.
     */
    startPluginThread(
        params: Readonly<
            {
                cwd: string;
                /** `ThreadOrigin.User` puts the thread in the sidebar for the user to pick up. */
                origin: ThreadOrigin;
                text: string;
                provider: AiProvider;
                model: string;
                runtimeMode: RuntimeMode;
                isInWorktree: boolean;
                /**
                 * Set on the thread's provider process over the folder's own variables. Kept for
                 * the thread's life, including across app restarts.
                 */
                env: Readonly<Record<string, string>>;
            } & PartialWithUndefined<{
                /** Generated from `text` when unset. */
                title: string;
                effort: ReasoningEffort;
                /**
                 * Signs the thread's provider in with this key instead of the user's own login.
                 * Kept for the thread's life, including across app restarts.
                 */
                apiKey: string;
            }>
        >,
    ): Promise<PluginThread>;
    /** Undefined for a thread that is archived or never existed. */
    readPluginThread(threadId: string): Promise<PluginThread | undefined>;
}>;

/**
 * Lives in common rather than in Build, so a plugin that runs Build threads needs no package
 * dependency on Build, which depends on it.
 */
export const buildExportsKey = definePluginServerExportsKey<BuildServerExports>(buildPluginId);
