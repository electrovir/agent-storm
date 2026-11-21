import {definePluginServerExportsKey} from './plugins.js';

export const buildV2PluginId = 'build-v2';

/** The pane a tab shows a thread in, which a tab of another plugin's thread uses too. */
export const aiChatPaneId = 'ai-chat';

/** Who started a thread. Only `User` threads show in the sidebar and to agent tools. */
export enum ThreadOrigin {
    User = 'user',
    /** Runs a PR review for the Review plugin. */
    Review = 'review',
    /** Runs watch mode's passes for the Review plugin. */
    Watch = 'watch',
    /** An extra AI Chat tab in a thread's tabs. Keeps the title it starts with. */
    SideChat = 'sideChat',
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

/** The part of a Build V2 thread the plugins that run threads get to see. */
export type PluginThread = Readonly<{
    id: string;
    status: ThreadStatus;
    origin: ThreadOrigin;
}>;

/** What Build V2's server part gives the plugins that run their AI work as its threads. */
export type BuildV2ServerExports = Readonly<{
    findPluginThread(target: PluginThreadTarget): Promise<PluginThread | undefined>;
    /**
     * Sends `text` to the target thread, or starts one with the folder's default model when there's
     * none. A new thread runs with full access, since nobody may be watching it to approve
     * actions.
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
}>;

/**
 * Lives in common rather than in Build V2, so a plugin that runs Build V2 threads needs no package
 * dependency on Build V2, which depends on it.
 */
export const buildV2ExportsKey =
    definePluginServerExportsKey<BuildV2ServerExports>(buildV2PluginId);
