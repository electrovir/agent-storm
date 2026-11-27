import {type HostedProcessAttachment, type PluginServerHost} from '@agent-storm/core/server';
import {type UsageRecordInput} from '@agent-storm/plugin-usage/src/usage-exports.js';
import {check} from '@augment-vir/assert';
import {
    getObjectTypedEntries,
    type MaybePromise,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {
    type ApprovalDecision,
    type ApprovalRequest,
    type ComposerCommand,
    type McpServer,
    type ProviderModel,
    type ReasoningEffort,
    type RuntimeMode,
    type ThreadItem,
    type ThreadStatus,
} from '../../build-api.js';
import {type AgentToolConnection} from '../agent-tool-server.js';

/**
 * Drops the unset variables a process's environment type allows, which a spawn handshake can't
 * carry.
 */
export function filterStringEnv(env: Readonly<Record<string, string | undefined>>) {
    return typedObjectFromEntries(
        getObjectTypedEntries(env).filter(
            (
                entry,
            ): entry is [
                string,
                string,
            ] => {
                return check.isString(entry[1]);
            },
        ),
    );
}

/** An item as a provider describes it, before it belongs to a thread and turn. */
export type ProviderItem = Readonly<
    Pick<ThreadItem, 'kind' | 'status' | 'title' | 'text'> & {
        /** The provider's own id for the item, which later updates to the same item reuse. */
        providerItemId: string;
    }
>;

/** What one model response spent. A repeated `dedupeKey` replaces the earlier record. */
export type ProviderUsage = Readonly<
    Pick<
        UsageRecordInput,
        | 'dedupeKey'
        | 'model'
        | 'inputTokens'
        | 'outputTokens'
        | 'cacheReadTokens'
        | 'cacheWriteTokens'
        | 'reasoningTokens'
    >
>;

/**
 * Runs a thread's provider process in Agent Storm's daemon, so it outlives this server. Attaching
 * again takes over the process already running for the thread.
 */
export type ProviderProcessHost = Readonly<{
    attach(
        params: Omit<Parameters<PluginServerHost['attachHostedProcess']>[0], 'processId'>,
    ): Promise<HostedProcessAttachment>;
}>;

/** Where a provider session reports what its agent does. Bound to one thread. */
export type ProviderSink = Readonly<{
    putItem(item: ProviderItem): MaybePromise<void>;
    appendDelta(params: Readonly<{providerItemId: string; delta: string}>): void;
    /**
     * The thread's item with this provider id as last saved, for an item a session before this
     * server's restart started.
     */
    findItem(
        providerItemId: string,
    ): Promise<Pick<ProviderItem, 'kind' | 'title' | 'text'> | undefined>;
    setStatus(status: ThreadStatus): MaybePromise<void>;
    setBackgroundTaskCount(count: number): MaybePromise<void>;
    /**
     * The provider's process stopped responding mid-work. Kills it and has the agent continue in a
     * new one.
     */
    reportStall(): MaybePromise<void>;
    /** Records the id the provider resumes the conversation by. */
    setProviderSessionId(providerSessionId: string): MaybePromise<void>;
    /**
     * Shows the user a request and resolves to their answer. Resolves to a decline when `signal`
     * aborts or the session stops first.
     */
    requestApproval(
        request: Readonly<Pick<ApprovalRequest, 'kind' | 'title' | 'detail' | 'reason'>>,
        signal?: AbortSignal | undefined,
    ): Promise<ApprovalDecision>;
    /**
     * Asks the user `questions` and resolves to one answer per question, in order. Resolves to
     * `undefined` when the user dismisses them, `signal` aborts, or the session stops first.
     */
    askQuestions(
        params: Readonly<Pick<ApprovalRequest, 'title' | 'reason' | 'questions'>>,
        signal?: AbortSignal | undefined,
    ): Promise<string[] | undefined>;
    addNotice(text: string): MaybePromise<void>;
    /** Logs a model response's tokens in the Usage plugin, when it runs. Never throws. */
    recordUsage(usage: ProviderUsage): MaybePromise<void>;
    /** The provider says its plan's rate limits changed, so Usage reads them again. */
    reportRateLimitsChanged(): void;
    /** The provider's process ended, so the next message must start a new session. */
    endSession(): void;
    /**
     * Kills the provider's process once the current turn ends, so the next message starts a new
     * one.
     */
    releaseSession(): void;
}>;

export type SessionModelSettings = Readonly<{
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
    /** The model's faster service tier, by its id. Unset for standard speed. */
    speedTier: string | undefined;
}>;

/** Lists and changes the MCP servers a provider's session connects to. */
export type McpControl = Readonly<{
    /** Leaves out Agent Storm's own tool server, which the session can't work without. */
    listServers(): Promise<McpServer[]>;
    setServerEnabled(params: Readonly<{serverName: string; isEnabled: boolean}>): Promise<void>;
    reconnectServer(serverName: string): Promise<void>;
    /**
     * Starts signing in to a server. The user finishes at `authUrl`, after which the provider
     * connects the server itself. `authUrl` is empty when the server needed no sign-in.
     */
    signIn(serverName: string): Promise<
        Readonly<{
            authUrl: string;
            /** Whether the sign-in page redirects to a localhost address on the server's machine. */
            isCallbackExpected: boolean;
        }>
    >;
    /**
     * Finishes a sign-in with the localhost address its sign-in page redirected to, for a browser
     * that can't reach that address itself.
     */
    submitSignInCallbackUrl(
        params: Readonly<{
            serverName: string;
            callbackUrl: string;
        }>,
    ): Promise<void>;
    /**
     * Connects servers added to the config since the session started, which it otherwise only reads
     * at startup. Unset where a session can't take new servers.
     */
    loadNewServers?: (() => Promise<void>) | undefined;
}>;

/** A running provider process for one thread. */
export type ProviderSession = Readonly<{
    /** Unset for a provider whose MCP servers Agent Storm can't manage. */
    mcp?: McpControl | undefined;
    send(
        params: Readonly<{
            text: string;
            /**
             * Where the user's own words start in `text`. Anything before it, such as an earlier
             * conversation handed over from another provider, is context.
             */
            userTextStart: number;
        }>,
    ): MaybePromise<void>;
    interrupt(): Promise<void>;
    setRuntimeMode(runtimeMode: RuntimeMode): MaybePromise<void>;
    /**
     * Switches models within the same provider without ending the session. Claude applies it from
     * its next request, mid-turn included. Codex applies it from the next message.
     */
    setModel(settings: SessionModelSettings): MaybePromise<void>;
    /**
     * Lets go of the provider's process without stopping it, which only the process host's kill
     * does.
     */
    stop(): void;
}>;

export type ProviderAdapter = Readonly<{
    /** Starts the provider's CLI in `cwd` only long enough to ask it for its models. */
    listModels(
        params: Readonly<{
            cwd: string;
        }>,
    ): Promise<ProviderModel[]>;
    /**
     * Starts the provider's CLI in `cwd` to manage its MCP servers without a thread's session,
     * until `close`. Unset for a provider whose MCP servers Agent Storm can't manage.
     */
    openMcpControl?:
        | ((
              params: Readonly<{
                  cwd: string;
                  /** Replaces the environment the provider runs with. Unset inherits the server's. */
                  env: Record<string, string> | undefined;
              }>,
          ) => Promise<McpControl & Readonly<{close(): void}>>)
        | undefined;
    /** Starts the provider's CLI in `cwd` only long enough to ask it for its commands and skills. */
    listCommands(
        params: Readonly<{
            cwd: string;
        }>,
    ): Promise<ComposerCommand[]>;
    /**
     * Runs one tool-free turn on `prompt` in a session that isn't saved, and resolves to the reply.
     * Uses a small model where the provider has one, else `model`.
     */
    generateTitle(
        params: Readonly<{
            cwd: string;
            /** Empty for the provider's default model. */
            model: string;
            prompt: string;
        }>,
    ): Promise<string>;
    start(
        params: Readonly<{
            cwd: string;
            /** Empty for the provider's default model. */
            model: string;
            /** Unset for the model's default effort. */
            effort: ReasoningEffort | undefined;
            /** The model's faster service tier, by its id. Unset for standard speed. */
            speedTier: string | undefined;
            runtimeMode: RuntimeMode;
            /** Resumes this conversation when set. */
            providerSessionId: string | null;
            sink: ProviderSink;
            /** Where the session's agent calls Agent Storm's own tools. */
            agentTools: AgentToolConnection;
            /** Replaces the environment the provider runs with. Unset inherits the server's. */
            env: Record<string, string> | undefined;
            /** Signs the provider in with this key instead of the user's own login. */
            apiKey: string | undefined;
            processHost: ProviderProcessHost;
        }>,
    ): Promise<ProviderSession>;
}>;
