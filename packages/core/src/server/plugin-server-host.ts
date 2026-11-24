import {
    type FolderInfo,
    type FolderSessions,
    type FolderSettings,
    type GitHubPollingDisableReason,
    type PaneKind,
    type PaneSessionStatus,
    type PaneStatus,
    type PrStatus,
    type SessionMeta,
    type Settings,
} from '@agent-storm/common';
import {type MaybePromise} from '@augment-vir/common';

/** A GitHub repo, as a checkout's `origin` remote names it. */
export type RepoSlug = {
    owner: string;
    name: string;
};

/** A branch's PR as the app's PR polling last saw it. */
export type BranchPrInfo = {
    url: string;
    status: PrStatus;
    baseBranch?: string | undefined;
};

/** A checkout's git state as the app last read it. */
export type FolderGitInfo = {
    /** Null when the folder isn't a checkout or is on a detached HEAD. */
    branch: string | null;
    dirty: boolean;
    notPushed: boolean;
};

/** One tab of a folder's pane. */
export type PaneSessionTarget = Readonly<{
    folder: string;
    kind: PaneKind;
    sessionId: string;
}>;

/**
 * A process the pty daemon runs for a plugin, outside any terminal, so it outlives the app's
 * server.
 */
export type HostedProcessAttachment = Readonly<{
    /** False when the process was already running, so this attach took it over mid-flight. */
    isNew: boolean;
    write(data: Buffer | string): void;
    /** Stops listening to the process without stopping it. */
    detach(): void;
}>;

/** How a hosted process ended. */
export type HostedProcessExit = Readonly<{
    /** Null when the process was killed by a signal or the daemon dropped the connection. */
    exitCode: number | null;
    signal: string | null;
    /** The end of what the process wrote to stderr. */
    stderr: string;
}>;

/**
 * The app's own state and machinery a plugin's server part reaches through, so the plugin never
 * imports the app's server. Every listener registration returns a function that removes it, which a
 * plugin must call from its `stop`.
 */
export type PluginServerHost = Readonly<{
    loadSettings(): Promise<Settings>;
    /** The folder's settings files, nearest first. Only the ones the user approved. */
    loadFolderSettings(folder: string): Promise<FolderSettings[]>;
    /** The sidebar's folders. */
    listFolders(): Promise<ReadonlyArray<Readonly<FolderInfo>>>;
    /**
     * The Claude session each AI tab last started, as Claude's session hook recorded it. Empty
     * while the hooks aren't installed. A tab's earlier sessions aren't kept.
     */
    listClaudeTabSessions(): Promise<
        ReadonlyArray<
            Readonly<{
                /** Normalized path. */
                folder: string;
                conversationId: string;
                claudeSessionId: string;
            }>
        >
    >;
    /**
     * Calls `listener` when a sweep finds a PR on a folder whose previous sweep found none. A
     * folder's first sweep never counts.
     */
    listenToNewFolderPrs(listener: (info: Readonly<FolderInfo>) => void): () => void;
    /**
     * Calls `listener` whenever a folder's PR or PR status changes, however the app learned it. A
     * folder's first read never counts.
     */
    listenToFolderPrChanges(listener: (info: Readonly<FolderInfo>) => void): () => void;
    /**
     * Records a PR state the plugin learned before the app's own polling would, and refreshes the
     * folder's sidebar entry.
     */
    recordFolderPrStatus(
        params: Readonly<{
            folder: string;
            slug: Readonly<RepoSlug>;
            branchName: string;
            prInfo: Readonly<BranchPrInfo>;
        }>,
    ): Promise<void>;
    /** Undefined unless the app's PR polling saw a PR at `url` on the branch. */
    readBranchPrStatus(
        params: Readonly<
            RepoSlug & {
                branchName: string;
                url: string;
            }
        >,
    ): PrStatus | undefined;
    /**
     * Shows `status` for the PR at `url` in every sidebar and PR list right away, for a change made
     * in agent-storm that GitHub doesn't show yet, like a verdict sent from the Approve button. It
     * stands over GitHub's answers until they catch up. An undefined `status` drops it.
     */
    holdPrStatus(
        params: Readonly<{
            url: string;
            status: PrStatus | undefined;
        }>,
    ): Promise<void>;
    /**
     * Records a branch's PR in the app's PR cache, and refreshes the sidebar entry of each folder
     * on the branch that doesn't show that PR or its status yet.
     */
    recordBranchPr(
        params: Readonly<
            RepoSlug & {
                branchName: string;
                prInfo: Readonly<BranchPrInfo>;
            }
        >,
    ): Promise<void>;
    /** Whether any running plugin's `isFolderBusy` says an agent it runs is mid-turn in the folder. */
    isFolderBusyInPlugins(folder: string): Promise<boolean>;
    /** Undefined unless the app has paused its GitHub calls, as after a rate limit. */
    readGitHubPause(): {reason: GitHubPollingDisableReason; resumeAtMs: number} | undefined;
    /**
     * Pauses the app's GitHub polling until the rate limit a plugin's own GitHub call hit resets,
     * so the app's calls and the plugin's stop spending the same budget.
     */
    pauseGitHubForRateLimit(message: string): Promise<void>;
    /**
     * Attaches to the daemon-hosted process `processId`, starting it from `spawn` when none runs.
     * The process's stdout written while nobody was attached arrives first. `onExit` also fires
     * when the daemon drops the connection for another reason, such as another attach taking the
     * process over, but never after `detach`.
     */
    attachHostedProcess(
        params: Readonly<{
            processId: string;
            spawn: Readonly<{
                command: string;
                args: string[];
                cwd: string;
                env: Record<string, string>;
            }>;
            /**
             * The process speaks JSON-RPC, one message per line. Its requests a previous attach got
             * but never answered are sent again on the next attach.
             */
            isJsonRpc?: boolean | undefined;
            onStdout(data: Buffer): void;
            onExit(exit: HostedProcessExit): void;
        }>,
    ): Promise<HostedProcessAttachment>;
    listHostedProcessIds(): Promise<string[]>;
    /** Kills the hosted process and everything it started. Does nothing when it isn't running. */
    killHostedProcess(processId: string): Promise<void>;
    /** Every folder the pty daemon holds a pane in. */
    listPaneFolders(): Promise<string[]>;
    killFolderPanes(params: Readonly<{folder: string}>): Promise<void>;
    getPaneStatusLookup(): Promise<(folder: string, kind: PaneKind) => PaneStatus>;
    getPaneSessionStatusLookup(): Promise<(folder: string) => ReadonlyArray<PaneSessionStatus>>;
    /** The tabs of the folder's pane the daemon holds a running process for. */
    getLivePaneSessionIds(folder: string, kind: PaneKind): Promise<ReadonlyArray<string>>;
    /** Deletes the UI state the app keeps for the folder, for a folder that's being deleted. */
    deleteFolderState(folder: string): Promise<void>;
    getFolderSessions(folder: string): Promise<FolderSessions>;
    createFolderSession(
        params: Readonly<{folder: string; kind: PaneKind}>,
    ): Promise<FolderSessions>;
    findFolderSession(params: PaneSessionTarget): Promise<SessionMeta | undefined>;
    renameFolderSession(
        params: Readonly<
            PaneSessionTarget & {
                name: string;
            }
        >,
    ): Promise<FolderSessions>;
    /** Whether Claude in the conversation is idle at its prompt, per its activity hook. */
    isClaudeReady(conversationId: string): Promise<boolean>;
    isClaudeAwaitingPermission(conversationId: string): Promise<boolean>;
    /** Starts the tab's process if it isn't running, the way opening its pane would. */
    spawnPane(params: PaneSessionTarget): Promise<void>;
    /** Types `text` into the tab and submits it, starting the tab's process first if needed. */
    sendPaneText(
        params: Readonly<
            PaneSessionTarget & {
                text: string;
            }
        >,
    ): Promise<void>;
    /** Sends `prompt` to the folder's first AI tab once its AI is ready for it. */
    launchFolderSession(params: Readonly<{folder: string; prompt: string}>): Promise<void>;
    /**
     * Types `command` into the folder's first shell tab, making one when it has none. False,
     * without typing anything, while that tab is running something.
     */
    runInIdleFolderShell(params: Readonly<{folder: string; command: string}>): Promise<boolean>;
    /**
     * Creates a worktree named `name`, branched from the checkout at `folder`, beside the repo's
     * other worktrees, then runs the post-worktree command in it the way the app's own "new
     * worktree" does.
     */
    createWorktree(
        params: Readonly<{
            folder: string;
            /** The new folder's name, which is also its new branch's name. */
            name: string;
        }>,
    ): Promise<{worktreePath: string}>;
    /**
     * Deletes the worktree folder the way the app's own "delete worktree" does, uncommitted changes
     * included, and closes its panes. Its branch stays.
     */
    deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void>;
    getCurrentBranch(folder: string): Promise<string | null>;
    getRepoSlug(folder: string): Promise<RepoSlug | null>;
    /** Calls `listener` whenever a read of a folder's git state finds it changed. */
    listenToGitInfoChanges(
        listener: (
            change: Readonly<{
                /** Normalized path. */
                folder: string;
                previous: Readonly<FolderGitInfo>;
                info: Readonly<FolderGitInfo>;
            }>,
        ) => void,
    ): () => void;
}>;

/** What a plugin's server part adds to the app's own folder info. */
export type PluginFolderHooks = Readonly<{
    /** Changes the PR status the app shows for a branch, such as to mark a review in progress. */
    overridePrStatus?:
        | ((
              params: Readonly<{
                  prStatus: PrStatus;
                  owner: string;
                  repoName: string;
                  branchName: string;
              }>,
          ) => MaybePromise<PrStatus>)
        | undefined;
    /** The folder's watch mode state. */
    readWatchMode?: ((folder: string) => FolderInfo['watchMode']) | undefined;
    /**
     * Whether an agent the plugin runs outside the folder's terminal tabs is mid-turn in the
     * folder, so automation that commits or pushes there, like watch mode, waits for it.
     */
    isFolderBusy?: ((folder: string) => MaybePromise<boolean>) | undefined;
}>;
