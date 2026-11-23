// cspell:words claudeai
import {
    query,
    type CanUseTool,
    type McpServerStatus as ClaudeMcpServerStatus,
    type EffortLevel,
    type HookCallback,
    type McpServerConfig,
    type PermissionMode,
    type PermissionResult,
    type Query,
    type SDKMessage,
    type SDKUserMessage,
    type SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import {check} from '@augment-vir/assert';
import {arrayToObject, extractErrorMessage, wait} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {homedir} from 'node:os';
import {assertValidShape, checkValidShape, defineShape, optionalShape} from 'object-shape-tester';
import {
    ApprovalDecision,
    McpServerState,
    ReasoningEffort,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
    type ProviderModel,
} from '../../build-v2-api.js';
import {isUploadPath} from '../../util/message-attachments.js';
import {parseReasoningEfforts} from '../../util/reasoning-effort.js';
import {agentToolServerName, agentToolTimeout} from '../agent-tool-server.js';
import {
    classifyClaudeCommands,
    dispatchClaudeSkillMentions,
    findClaudeConfigDir,
    hasSkillMention,
    readClaudeCommandOrigins,
} from './claude-commands.js';
import {
    claudeApprovalKinds,
    completeClaudeToolItem,
    describeClaudeToolUse,
    readClaudeMessageUsage,
    readClaudeToolResultImages,
    readClaudeToolResultText,
    readOnlyClaudeTools,
    type ClaudeToolDescription,
} from './claude-items.js';
import {restoreClaudeTranscript} from './claude-transcript.js';
import {spawnHostedClaudeProcess} from './hosted-claude-process.js';
import {
    filterStringEnv,
    type McpControl,
    type ProviderAdapter,
    type ProviderSink,
} from './provider-session.js';

/**
 * How long a working session may send nothing before it counts as stalled. Claude Code streams
 * every reply and reports a running command's progress, so a healthy session is never this quiet.
 * It outlasts `agentToolTimeout`, the longest an Agent Storm tool call can keep it waiting.
 */
const stallTimeout = {
    minutes: 15,
} as const satisfies AnyDuration;

const askUserQuestionInputShape = defineShape({
    questions: [
        {
            header: '',
            question: '',
            multiSelect: optionalShape(false, {
                alsoUndefined: true,
            }),
            options: [
                {
                    label: '',
                    description: optionalShape('', {
                        alsoUndefined: true,
                    }),
                    preview: optionalShape('', {
                        alsoUndefined: true,
                    }),
                },
            ],
        },
    ],
});

/** The levels Claude Code accepts. It has no equivalent of Ultra. */
const claudeEfforts: Readonly<Partial<Record<ReasoningEffort, EffortLevel>>> = {
    [ReasoningEffort.Low]: 'low',
    [ReasoningEffort.Medium]: 'medium',
    [ReasoningEffort.High]: 'high',
    [ReasoningEffort.ExtraHigh]: 'xhigh',
    [ReasoningEffort.Max]: 'max',
};

const claudePermissionModes: Readonly<Record<RuntimeMode, PermissionMode>> = {
    [RuntimeMode.Supervised]: 'default',
    [RuntimeMode.AutoAcceptEdits]: 'acceptEdits',
    [RuntimeMode.Auto]: 'auto',
    [RuntimeMode.FullAccess]: 'bypassPermissions',
};

/** The speed tier id for Claude Code's fast mode. */
const claudeFastSpeedTier = 'fast';

const claudeFastSpeedTiers: ProviderModel['speedTiers'] = [
    {
        id: claudeFastSpeedTier,
        name: 'Fast',
    },
];

/**
 * Older Claude versions. Claude Code lists only the current version of each family, so the version
 * it replaces goes here when a new one ships.
 */
const olderClaudeModels: ReadonlyArray<ProviderModel> = [
    {
        id: 'claude-fable-5-1',
        name: 'Fable 5.1',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: [],
    },
    {
        id: 'claude-fable-5',
        name: 'Fable 5',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: [],
    },
    {
        id: 'claude-opus-5',
        name: 'Opus 5',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: claudeFastSpeedTiers,
    },
    {
        id: 'claude-opus-4-8',
        name: 'Opus 4.8',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: claudeFastSpeedTiers,
    },
    {
        id: 'claude-opus-4-7',
        name: 'Opus 4.7',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: claudeFastSpeedTiers,
    },
    {
        id: 'claude-opus-4-6',
        name: 'Opus 4.6',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.Max,
        ],
        speedTiers: claudeFastSpeedTiers,
    },
    {
        id: 'claude-opus-4-5',
        name: 'Opus 4.5',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.Max,
        ],
        speedTiers: claudeFastSpeedTiers,
    },
    {
        id: 'claude-sonnet-5',
        name: 'Sonnet 5',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.ExtraHigh,
            ReasoningEffort.Max,
        ],
        speedTiers: [],
    },
    {
        id: 'claude-sonnet-4-6',
        name: 'Sonnet 4.6',
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.Medium,
            ReasoningEffort.High,
            ReasoningEffort.Max,
        ],
        speedTiers: [],
    },
    {
        id: 'claude-haiku-4-5',
        name: 'Haiku 4.5',
        supportedEfforts: [],
        speedTiers: [],
    },
].map((model) => {
    return {
        ...model,
        description: '',
        isDefault: false,
        isLegacy: true,
    };
});

/**
 * Claude Code names a model by family alone ("Opus") and starts its description with the version
 * ("Opus 5.5 · Best for everyday, complex tasks"), so the version moves into the name.
 */
function splitClaudeModelVersion({
    displayName,
    description,
    isDefault,
}: Readonly<{displayName: string; description: string; isDefault: boolean}>) {
    const [
        version,
        ...rest
    ] = description.split(' · ');
    return version && rest.length
        ? {
              name: isDefault ? `Default (${version})` : version,
              description: rest.join(' · '),
          }
        : {
              name: displayName,
              description,
          };
}

/** The messages a session sends Claude, as the async iterable `query` reads its prompt from. */
function createMessageQueue() {
    const state: {
        messages: SDKUserMessage[];
        wake: (() => void) | undefined;
        isClosed: boolean;
    } = {
        messages: [],
        wake: undefined,
        isClosed: false,
    };
    return {
        push(content: SDKUserMessage['message']['content']) {
            state.messages.push({
                type: 'user',
                message: {
                    role: 'user',
                    content,
                },
                parent_tool_use_id: null,
                origin: {
                    kind: 'human',
                },
            });
            state.wake?.();
        },
        close() {
            state.isClosed = true;
            state.wake?.();
        },
        async *[Symbol.asyncIterator]() {
            while (!state.isClosed) {
                const message = state.messages.shift();
                if (message) {
                    yield message;
                } else {
                    await new Promise<void>((resolve) => {
                        state.wake = resolve;
                    });
                    state.wake = undefined;
                }
            }
        },
    };
}

const claudeMcpServerStates: Readonly<Record<ClaudeMcpServerStatus['status'], McpServerState>> = {
    connected: McpServerState.Connected,
    pending: McpServerState.Pending,
    failed: McpServerState.Failed,
    'needs-auth': McpServerState.NeedsAuth,
    disabled: McpServerState.Disabled,
};

/** Claude Code's reply to starting an MCP server's sign-in. */
const claudeMcpSignInReplyShape = defineShape({
    authUrl: optionalShape('', {
        alsoUndefined: true,
    }),
    callbackExpected: optionalShape(false, {
        alsoUndefined: true,
    }),
});

/**
 * The SDK's `Query` sends Claude Code's MCP sign-in requests (`mcp_authenticate`,
 * `mcp_oauth_callback_url`) but leaves these methods out of its type declarations.
 */
type ClaudeMcpSignInQuery = Query &
    Readonly<{
        mcpAuthenticate(serverName: string): Promise<unknown>;
        mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown>;
    }>;

/**
 * Claude Code saves a server turned on or off for the session's folder, so it stays that way in the
 * folder's later sessions.
 */
function createClaudeMcpControl(claudeQuery: Query): McpControl {
    return {
        async listServers() {
            return (
                (await claudeQuery.mcpServerStatus())
                    /**
                     * A session started before `createClaudeEnv` turned claude.ai connectors off
                     * still has them loaded.
                     */
                    .filter((server) => {
                        return server.name !== agentToolServerName && server.scope !== 'claudeai';
                    })
                    .map((server) => {
                        return {
                            name: server.name,
                            state: claudeMcpServerStates[server.status],
                            error: server.error || '',
                            scope: server.scope || '',
                            toolCount: server.tools?.length ?? 0,
                        };
                    })
            );
        },
        async setServerEnabled({serverName, isEnabled}) {
            await claudeQuery.toggleMcpServer(serverName, isEnabled);
        },
        async reconnectServer(serverName) {
            await claudeQuery.reconnectMcpServer(serverName);
        },
        async signIn(serverName) {
            const reply = await (
                claudeQuery satisfies Query as ClaudeMcpSignInQuery
            ).mcpAuthenticate(serverName);
            assertValidShape(reply, claudeMcpSignInReplyShape, {
                allowExtraKeys: true,
            });
            return {
                authUrl: reply.authUrl || '',
                isCallbackExpected: !!reply.callbackExpected,
            };
        },
        async submitSignInCallbackUrl({serverName, callbackUrl}) {
            await (claudeQuery satisfies Query as ClaudeMcpSignInQuery).mcpSubmitOAuthCallbackUrl(
                serverName,
                callbackUrl,
            );
        },
    };
}

/**
 * Closes a Claude process once none of its MCP servers is still connecting. Connecting can refresh
 * a server's OAuth token, and Slack's OAuth server replaces the refresh token on every refresh: a
 * process killed after Slack answers but before Claude Code saves the answer loses the only valid
 * refresh token, so the next refresh fails with `invalid_grant` and Claude Code signs every session
 * out of Slack.
 */
async function closeClaudeQueryWhenMcpSettles({
    claudeQuery,
    prompt,
}: Readonly<{
    claudeQuery: Query;
    prompt: Readonly<{
        close(): void;
    }>;
}>) {
    try {
        await waitForMcpServersToSettle({
            claudeQuery,
            deadline:
                Date.now() +
                convertDuration(
                    {
                        minutes: 1,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
        });
    } catch {
        /** The process already exited, so it has nothing left to save. */
    } finally {
        prompt.close();
        claudeQuery.close();
    }
}

/** Recursive, so TypeScript needs the return type. */
async function waitForMcpServersToSettle({
    claudeQuery,
    deadline,
}: Readonly<{
    claudeQuery: Query;
    deadline: number;
}>): Promise<void> {
    const servers = await claudeQuery.mcpServerStatus();
    if (Date.now() >= deadline || !servers.some((server) => server.status === 'pending')) {
        return;
    }
    await wait({
        milliseconds: 250,
    });
    await waitForMcpServersToSettle({
        claudeQuery,
        deadline,
    });
}

/**
 * The environment every Claude Code process gets. It turns off claude.ai connectors, so a session
 * loads only the MCP servers the CLI itself is configured with.
 */
function createClaudeEnv(env: Readonly<Record<string, string>> | undefined) {
    return {
        ...(env || process.env),
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    };
}

/**
 * The MCP servers a Claude Code process started in `cwd` now would load, which a running session
 * only reads when it starts. Leaves out the kinds `setMcpServers` can't take.
 */
async function readConfiguredMcpServers({
    cwd,
    env,
}: Readonly<{
    cwd: string;
    env: Readonly<Record<string, string>> | undefined;
}>) {
    const prompt = createMessageQueue();
    const claudeQuery = query({
        prompt,
        options: {
            cwd,
            env: createClaudeEnv(env),
            persistSession: false,
        },
    });
    try {
        return (await claudeQuery.mcpServerStatus()).flatMap((server) => {
            const config = server.config;
            return config && config.type !== 'sdk' && config.type !== 'claudeai-proxy'
                ? [
                      {
                          name: server.name,
                          config,
                      },
                  ]
                : [];
        });
    } finally {
        void closeClaudeQueryWhenMcpSettles({
            claudeQuery,
            prompt,
        });
    }
}

/** What a session approved for the rest of the session: a whole tool, or one exact command. */
function createApprovalKey(toolName: string, input: Readonly<Record<string, unknown>>) {
    return toolName === 'Bash' && check.isString(input.command)
        ? `Bash:${input.command}`
        : toolName;
}

/**
 * Runs Claude through the Agent SDK. The thread's runtime mode decides which tools ask the user
 * first. Supervised asks before every tool that isn't read-only.
 */
export function createClaudeProvider(sessionStore: SessionStore): ProviderAdapter {
    return {
        async listModels({cwd}) {
            const prompt = createMessageQueue();
            const claudeQuery = query({
                prompt,
                options: {
                    cwd,
                    env: createClaudeEnv(undefined),
                    /** Skips connecting MCP servers, which listing models doesn't need. */
                    strictMcpConfig: true,
                },
            });
            try {
                const reportedModels = await claudeQuery.supportedModels();
                const reportedIds = reportedModels.map((model) => model.resolvedModel);
                return [
                    ...reportedModels.map((model): ProviderModel => {
                        /** Claude Code lists its default model under the value `default`. */
                        const isDefault = model.value === 'default';
                        return {
                            id: model.value,
                            ...splitClaudeModelVersion({
                                displayName: model.displayName,
                                description: model.description,
                                isDefault,
                            }),
                            isDefault,
                            isLegacy: false,
                            supportedEfforts: model.supportsEffort
                                ? parseReasoningEfforts(model.supportedEffortLevels)
                                : [],
                            speedTiers: model.supportsFastMode ? claudeFastSpeedTiers : [],
                        };
                    }),
                    ...olderClaudeModels.filter((model) => !reportedIds.includes(model.id)),
                ];
            } finally {
                prompt.close();
                claudeQuery.close();
            }
        },
        async listCommands({cwd}) {
            const prompt = createMessageQueue();
            const claudeQuery = query({
                prompt,
                options: {
                    cwd,
                    env: createClaudeEnv(undefined),
                },
            });
            try {
                const [
                    commands,
                    origins,
                ] = await Promise.all([
                    claudeQuery.supportedCommands(),
                    readClaudeCommandOrigins({
                        cwd,
                        configDir: findClaudeConfigDir(),
                        home: homedir(),
                    }),
                ]);
                return classifyClaudeCommands({
                    commands,
                    origins,
                });
            } finally {
                void closeClaudeQueryWhenMcpSettles({
                    claudeQuery,
                    prompt,
                });
            }
        },
        openMcpControl({cwd, env}) {
            const prompt = createMessageQueue();
            const claudeQuery = query({
                prompt,
                options: {
                    cwd,
                    env: createClaudeEnv(env),
                },
            });
            return Promise.resolve({
                ...createClaudeMcpControl(claudeQuery),
                close() {
                    void closeClaudeQueryWhenMcpSettles({
                        claudeQuery,
                        prompt,
                    });
                },
            });
        },
        async generateTitle({cwd, prompt}) {
            const claudeQuery = query({
                prompt,
                options: {
                    cwd,
                    env: createClaudeEnv(undefined),
                    model: 'haiku',
                    tools: [],
                    maxTurns: 1,
                    persistSession: false,
                    /** Skips the user's hooks and the repo's CLAUDE.md, which a title doesn't need. */
                    settingSources: [],
                    /** Skips connecting MCP servers, which a title doesn't need either. */
                    strictMcpConfig: true,
                },
            });
            for await (const message of claudeQuery) {
                if (message.type === 'result') {
                    return message.subtype === 'success' ? message.result : '';
                }
            }
            return '';
        },
        async start({
            cwd,
            model,
            effort,
            speedTier,
            runtimeMode,
            providerSessionId,
            sink,
            agentTools,
            env,
            processHost,
        }) {
            if (providerSessionId) {
                await restoreClaudeTranscript({
                    sessionStore,
                    sessionId: providerSessionId,
                    cwd,
                    configDir: env?.CLAUDE_CONFIG_DIR || findClaudeConfigDir(),
                });
            }
            const state = {
                runtimeMode,
                /** The id of the message the stream events currently belong to. */
                streamMessageId: '',
                /** How many content blocks each message's `assistant` messages have carried. */
                blockCounts: new Map<string, number>(),
                toolItems: new Map<string, ClaudeToolDescription>(),
                declinedToolIds: new Set<string>(),
                /** `Read` calls on the user's own uploads, whose images the chat already shows. */
                uploadReadIds: new Set<string>(),
                sessionApprovals: new Set<string>(),
                wasInterrupted: false,
                isStopped: false,
                hasAuthFailed: false,
                /** Live background tasks, which can outlive the reply that started them. */
                backgroundTaskIds: [] as string[],
                /** A reply is streaming, rather than the session only waiting on background tasks. */
                isReplying: false,
                /**
                 * The thread isn't known to show as running, so a reply starting must mark it. A
                 * session that took over a process from before a restart can't know.
                 */
                isSettled: true,
                /** Epoch milliseconds of the latest message from Claude Code or the user. */
                lastActivityAt: Date.now(),
                /** Approvals and questions waiting on the user, which no stall timeout applies to. */
                userRequestCount: 0,
                /** Settles once every earlier `send` has queued its message. */
                previousSend: Promise.resolve() as Promise<unknown>,
                /**
                 * Servers `loadNewServers` added. Each `setMcpServers` call drops the ones it
                 * doesn't name.
                 */
                addedMcpServers: {} satisfies Record<string, McpServerConfig> as Record<
                    string,
                    McpServerConfig
                >,
            };
            const messages = createMessageQueue();

            /**
             * The user's settings can allow tools outright, which would skip `canUseTool`. Asking
             * here sends every tool that isn't read-only through it while Supervised.
             */
            const askBeforeWrites: HookCallback = (input) => {
                return Promise.resolve(
                    state.runtimeMode === RuntimeMode.Supervised &&
                        input.hook_event_name === 'PreToolUse' &&
                        !readOnlyClaudeTools.includes(input.tool_name)
                        ? {
                              hookSpecificOutput: {
                                  hookEventName: 'PreToolUse',
                                  permissionDecision: 'ask',
                              },
                          }
                        : {},
                );
            };

            async function waitForUser<Answer>(request: Promise<Answer>) {
                state.userRequestCount++;
                try {
                    return await request;
                } finally {
                    state.userRequestCount--;
                    state.lastActivityAt = Date.now();
                }
            }

            const canUseTool: CanUseTool = async (toolName, input, {signal, toolUseID, title}) => {
                const approvalKey = createApprovalKey(toolName, input);
                const allowed = {
                    behavior: 'allow',
                    updatedInput: input,
                } as const satisfies PermissionResult;
                if (
                    readOnlyClaudeTools.includes(toolName) ||
                    state.sessionApprovals.has(approvalKey)
                ) {
                    return allowed;
                } else if (
                    toolName === 'AskUserQuestion' &&
                    checkValidShape(input, askUserQuestionInputShape, {
                        allowExtraKeys: true,
                    })
                ) {
                    const answers = await waitForUser(
                        sink.askQuestions(
                            {
                                title: 'Question',
                                reason: title || '',
                                questions: input.questions.map(
                                    ({multiSelect, options, ...question}) => {
                                        return {
                                            ...question,
                                            isMultiSelect: !!multiSelect,
                                            options: options.map((option) => {
                                                return {
                                                    label: option.label,
                                                    description: option.description || '',
                                                    preview: option.preview || '',
                                                };
                                            }),
                                        };
                                    },
                                ),
                            },
                            signal,
                        ),
                    );
                    if (!answers) {
                        state.declinedToolIds.add(toolUseID);
                        return {
                            behavior: 'deny',
                            message: 'The user dismissed the question without answering.',
                        };
                    }
                    return {
                        behavior: 'allow',
                        updatedInput: {
                            ...input,
                            /** Claude Code reads each answer by its question's text. */
                            answers: arrayToObject(input.questions, (question, index) => {
                                return {
                                    key: question.question,
                                    value: answers[index] || '',
                                };
                            }),
                        },
                    };
                } else if (state.runtimeMode === RuntimeMode.FullAccess) {
                    /**
                     * `bypassPermissions` still sends tools an MCP server marks always-ask, and
                     * commands that trip Claude Code's own safety checks, here.
                     */
                    return allowed;
                } else {
                    const tool = describeClaudeToolUse({
                        name: toolName,
                        input,
                    });
                    const decision = await waitForUser(
                        sink.requestApproval(
                            {
                                kind: claudeApprovalKinds[tool.kind],
                                title: tool.title || toolName,
                                detail: tool.text,
                                /** Claude writes a plain-words summary of what each command does. */
                                reason:
                                    (check.isString(input.description) && input.description) ||
                                    title ||
                                    '',
                            },
                            signal,
                        ),
                    );
                    const results: Readonly<Record<ApprovalDecision, () => PermissionResult>> = {
                        [ApprovalDecision.Approve]() {
                            return {
                                behavior: 'allow',
                                updatedInput: input,
                            };
                        },
                        [ApprovalDecision.ApproveForSession]() {
                            state.sessionApprovals.add(approvalKey);
                            return {
                                behavior: 'allow',
                                updatedInput: input,
                            };
                        },
                        [ApprovalDecision.Decline]() {
                            state.declinedToolIds.add(toolUseID);
                            return {
                                behavior: 'deny',
                                message: 'The user declined this.',
                            };
                        },
                    };
                    return results[decision]();
                }
            };

            const agentToolMcpServers = {
                [agentToolServerName]: {
                    type: 'http',
                    url: agentTools.url,
                    headers: {
                        Authorization: `Bearer ${agentTools.token}`,
                    },
                    timeout: convertDuration(agentToolTimeout, {
                        milliseconds: true,
                    }).milliseconds,
                    /** Keeps the tools in the prompt instead of behind tool search. */
                    alwaysLoad: true,
                },
            } satisfies Record<string, McpServerConfig>;

            const claudeQuery = query({
                prompt: messages,
                options: {
                    cwd,
                    env: createClaudeEnv(env),
                    ...(model
                        ? {
                              model,
                          }
                        : {}),
                    ...(effort && claudeEfforts[effort]
                        ? {
                              effort: claudeEfforts[effort],
                          }
                        : {}),
                    /**
                     * Not the `resume` option: with `sessionStore` set, the SDK resumes from a
                     * temporary config folder that drops the user's plugins, skills, and
                     * `CLAUDE.md`. `restoreClaudeTranscript` already put the transcript where
                     * Claude Code looks.
                     */
                    ...(providerSessionId
                        ? {
                              extraArgs: {
                                  resume: providerSessionId,
                              },
                          }
                        : {}),
                    /** Overrides `fastMode` in the user's settings. */
                    settings: {
                        fastMode: speedTier === claudeFastSpeedTier,
                        /**
                         * The SDK deletes `NODE_OPTIONS` from the environment it spawns Claude
                         * with. Settings `env` puts it back for the agent's own commands.
                         */
                        env: filterStringEnv({
                            NODE_OPTIONS: (env || process.env).NODE_OPTIONS,
                        }),
                    },
                    sessionStore,
                    /**
                     * The default `'batched'` flush only writes a turn's entries when it ends, so a
                     * restart mid-turn lost the user's message and everything after it.
                     */
                    sessionStoreFlush: 'eager',
                    includePartialMessages: true,
                    /** Overrides a `defaultMode` in the user's settings. */
                    permissionMode: claudePermissionModes[runtimeMode],
                    /** Lets the thread switch to Full access later without a restart. */
                    allowDangerouslySkipPermissions: true,
                    canUseTool,
                    spawnClaudeCodeProcess(spawnOptions) {
                        return spawnHostedClaudeProcess({
                            processHost,
                            spawnOptions,
                        });
                    },
                    mcpServers: agentToolMcpServers,
                    hooks: {
                        PreToolUse: [
                            {
                                hooks: [
                                    askBeforeWrites,
                                ],
                            },
                        ],
                    },
                },
            });

            async function handleMessage(message: SDKMessage) {
                /** Before sub-agents' messages are skipped, since their tokens count too. */
                if (message.type === 'assistant') {
                    const usage = readClaudeMessageUsage(message.message);
                    if (usage) {
                        await sink.recordUsage(usage);
                    }
                } else if (message.type === 'rate_limit_event') {
                    sink.reportRateLimitsChanged();
                }
                if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
                    /** A sub-agent's own steps, which its `Task` tool call already stands for. */
                    return;
                }
                if (message.type === 'system') {
                    if (message.subtype === 'init') {
                        await sink.setProviderSessionId(message.session_id);
                        state.isReplying = true;
                        /** A finished background task starts a reply no user message sent. */
                        if (state.isSettled) {
                            state.isSettled = false;
                            await sink.setStatus(ThreadStatus.Running);
                        }
                    } else if (message.subtype === 'background_tasks_changed') {
                        const activeTasks = message.tasks.filter((task) => !task.ambient);
                        state.backgroundTaskIds = activeTasks
                            /**
                             * A background command, such as a dev server, can run for as long as
                             * the session does, so only agents keep the thread working. Commands
                             * still count toward the indicator an idle thread shows.
                             */
                            .filter((task) => task.task_type !== 'local_bash')
                            .map((task) => task.task_id);
                        await sink.setBackgroundTaskCount(activeTasks.length);
                    } else if (message.subtype === 'mirror_error') {
                        await sink.addNotice(`Saving the transcript failed: ${message.error}`);
                    }
                } else if (message.type === 'stream_event') {
                    await handleStreamEvent(message.event);
                } else if (message.type === 'assistant') {
                    if (message.error === 'authentication_failed') {
                        state.hasAuthFailed = true;
                    }
                    await handleAssistantMessage(message.message);
                } else if (message.type === 'user') {
                    await handleToolResults(message.message.content);
                } else if (message.type === 'result') {
                    state.isReplying = false;
                    if (message.subtype === 'success' || state.wasInterrupted) {
                        /**
                         * The result arrives while background tasks still run. Each one's end
                         * starts another reply, whose result settles the thread.
                         */
                        if (state.wasInterrupted || !state.backgroundTaskIds.length) {
                            state.isSettled = true;
                            await sink.setStatus(ThreadStatus.Idle);
                        }
                    } else {
                        await sink.addNotice(
                            message.errors.join('\n') || `Claude stopped: ${message.subtype}.`,
                        );
                        state.isSettled = true;
                        await sink.setStatus(ThreadStatus.Failed);
                    }
                    state.wasInterrupted = false;
                    if (state.hasAuthFailed) {
                        /**
                         * Claude Code keeps the credentials it started with, so a revoked token
                         * fails every later turn until a new process reads the user's new login.
                         */
                        sink.releaseSession();
                    }
                }
            }

            async function handleStreamEvent(
                event: Extract<SDKMessage, {type: 'stream_event'}>['event'],
            ) {
                if (event.type === 'message_start') {
                    state.streamMessageId = event.message.id;
                } else if (!state.streamMessageId) {
                    /**
                     * A session that reconnects mid-message never sees that message's start, so its
                     * blocks can't get the ids the finished `assistant` message saves them under.
                     * That message still saves them, just without streaming.
                     */
                    return;
                } else if (event.type === 'content_block_start') {
                    const kind =
                        event.content_block.type === 'text'
                            ? ThreadItemKind.AssistantMessage
                            : event.content_block.type === 'thinking'
                              ? ThreadItemKind.Reasoning
                              : undefined;
                    if (kind) {
                        await sink.putItem({
                            providerItemId: `${state.streamMessageId}:${event.index}`,
                            kind,
                            status: ThreadItemStatus.InProgress,
                            title: '',
                            text: '',
                        });
                    }
                } else if (event.type === 'content_block_delta') {
                    const delta =
                        event.delta.type === 'text_delta'
                            ? event.delta.text
                            : event.delta.type === 'thinking_delta'
                              ? event.delta.thinking
                              : '';
                    sink.appendDelta({
                        providerItemId: `${state.streamMessageId}:${event.index}`,
                        delta,
                    });
                }
            }

            async function handleAssistantMessage(
                message: Extract<SDKMessage, {type: 'assistant'}>['message'],
            ) {
                /**
                 * The SDK sends a message's content blocks across several `assistant` messages
                 * sharing the message's id, so counting the blocks seen so far recovers each one's
                 * index in the stream events.
                 */
                const firstIndex = state.blockCounts.get(message.id) ?? 0;
                state.blockCounts.set(message.id, firstIndex + message.content.length);
                await Promise.all(
                    message.content.map(async (block, offset) => {
                        const providerItemId = `${message.id}:${firstIndex + offset}`;
                        if (block.type === 'text') {
                            await sink.putItem({
                                providerItemId,
                                kind: ThreadItemKind.AssistantMessage,
                                status: ThreadItemStatus.Completed,
                                title: '',
                                text: block.text,
                            });
                        } else if (block.type === 'thinking') {
                            await sink.putItem({
                                providerItemId,
                                kind: ThreadItemKind.Reasoning,
                                status: ThreadItemStatus.Completed,
                                title: '',
                                text: block.thinking,
                            });
                        } else if (block.type === 'tool_use') {
                            const tool = describeClaudeToolUse({
                                name: block.name,
                                input: check.isObject(block.input) ? block.input : {},
                            });
                            state.toolItems.set(block.id, tool);
                            if (
                                block.name === 'Read' &&
                                check.isObject(block.input) &&
                                check.isString(block.input.file_path) &&
                                isUploadPath(block.input.file_path)
                            ) {
                                state.uploadReadIds.add(block.id);
                            }
                            await sink.putItem({
                                ...tool,
                                providerItemId: block.id,
                                status: ThreadItemStatus.InProgress,
                            });
                        }
                    }),
                );
            }

            async function handleToolResults(content: unknown) {
                await Promise.all(
                    (check.isArray(content) ? content : [])
                        .filter(check.isObject)
                        .map(async (block) => {
                            const toolUseId = block.tool_use_id;
                            if (block.type !== 'tool_result' || !check.isString(toolUseId)) {
                                return;
                            }
                            /** A tool call from before this server restarted is only saved. */
                            const tool =
                                state.toolItems.get(toolUseId) || (await sink.findItem(toolUseId));
                            if (!tool) {
                                return;
                            }
                            state.toolItems.delete(toolUseId);
                            await sink.putItem({
                                ...completeClaudeToolItem({
                                    tool,
                                    output: readClaudeToolResultText(block.content),
                                    isError: block.is_error === true,
                                    isDeclined: state.declinedToolIds.delete(toolUseId),
                                }),
                                inlineImages: state.uploadReadIds.delete(toolUseId)
                                    ? []
                                    : readClaudeToolResultImages(block.content),
                                providerItemId: toolUseId,
                            });
                        }),
                );
            }

            async function readMessages(sessionSink: ProviderSink) {
                try {
                    for await (const message of claudeQuery) {
                        state.lastActivityAt = Date.now();
                        await handleMessage(message);
                    }
                } catch (error) {
                    /**
                     * An idle process that exits, such as one killed to restart it, cost no work,
                     * and the thread's next message starts a new one.
                     */
                    const wasIdle = state.isSettled && !state.isReplying;
                    if (!state.isStopped && !wasIdle) {
                        await sessionSink.addNotice(`Claude failed: ${extractErrorMessage(error)}`);
                        await sessionSink.setStatus(ThreadStatus.Failed);
                    }
                } finally {
                    clearInterval(stallCheck);
                    sessionSink.endSession();
                }
            }

            const stallCheck = setInterval(
                () => {
                    if (
                        (!state.isReplying && !state.backgroundTaskIds.length) ||
                        state.userRequestCount ||
                        Date.now() - state.lastActivityAt <
                            convertDuration(stallTimeout, {
                                milliseconds: true,
                            }).milliseconds
                    ) {
                        return;
                    }
                    clearInterval(stallCheck);
                    void sink.reportStall();
                },
                convertDuration(
                    {
                        minutes: 1,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            );
            stallCheck.unref();

            void readMessages(sink);

            return Promise.resolve({
                mcp: {
                    ...createClaudeMcpControl(claudeQuery),
                    async loadNewServers() {
                        const [
                            configured,
                            loaded,
                        ] = await Promise.all([
                            readConfiguredMcpServers({
                                cwd,
                                env,
                            }),
                            claudeQuery.mcpServerStatus(),
                        ]);
                        const loadedNames = loaded.map((server) => server.name);
                        const newServers = configured.filter(
                            (server) => !loadedNames.includes(server.name),
                        );
                        if (!newServers.length) {
                            return;
                        }
                        state.addedMcpServers = newServers.reduce((servers, server) => {
                            return {
                                ...servers,
                                [server.name]: server.config,
                            };
                        }, state.addedMcpServers);
                        await claudeQuery.setMcpServers({
                            ...agentToolMcpServers,
                            ...state.addedMcpServers,
                        });
                    },
                },
                async send({text, userTextStart}) {
                    /** Skips asking Claude Code for its commands when no `$` could start a mention. */
                    const content = hasSkillMention(text.slice(userTextStart))
                        ? claudeQuery.supportedCommands().then((commands) => {
                              return dispatchClaudeSkillMentions({
                                  text,
                                  commandNames: commands.map((command) => command.name),
                                  mentionsFrom: userTextStart,
                              });
                          })
                        : text;
                    /**
                     * Looking up the commands takes a moment, so a later message without a mention
                     * waits for it rather than reaching Claude first.
                     */
                    state.isReplying = true;
                    state.lastActivityAt = Date.now();
                    const queued = state.previousSend.then(async () => {
                        messages.push(await content);
                    });
                    state.previousSend = queued.catch(() => undefined);
                    await queued;
                },
                async interrupt() {
                    state.wasInterrupted = true;
                    /** Interrupting stops only the reply, never a background task. */
                    await Promise.all([
                        claudeQuery.interrupt(),
                        ...state.backgroundTaskIds.map((taskId) => claudeQuery.stopTask(taskId)),
                    ]);
                    /** Without a reply to interrupt, no result arrives to settle the thread. */
                    if (!state.isReplying) {
                        state.wasInterrupted = false;
                        state.isSettled = true;
                        await sink.setStatus(ThreadStatus.Idle);
                    }
                },
                async setRuntimeMode(newRuntimeMode) {
                    state.runtimeMode = newRuntimeMode;
                    await claudeQuery.setPermissionMode(claudePermissionModes[newRuntimeMode]);
                },
                async setModel(settings) {
                    await claudeQuery.setModel(settings.model || undefined);
                    await claudeQuery.applyFlagSettings({
                        fastMode: settings.speedTier === claudeFastSpeedTier,
                        /** `null` returns the session to the model's default effort. */
                        effortLevel: (settings.effort && claudeEfforts[settings.effort]) || null,
                    });
                },
                stop() {
                    state.isStopped = true;
                    clearInterval(stallCheck);
                    messages.close();
                    claudeQuery.close();
                },
            });
        },
    };
}
