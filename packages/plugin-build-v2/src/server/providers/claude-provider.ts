import {
    query,
    type CanUseTool,
    type EffortLevel,
    type HookCallback,
    type PermissionMode,
    type PermissionResult,
    type SDKMessage,
    type SDKUserMessage,
    type SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
import {check} from '@augment-vir/assert';
import {extractErrorMessage} from '@augment-vir/common';
import {
    ApprovalDecision,
    ReasoningEffort,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
} from '../../build-v2-api.js';
import {parseReasoningEfforts} from '../../util/reasoning-effort.js';
import {
    claudeApprovalKinds,
    completeClaudeToolItem,
    describeClaudeToolUse,
    readClaudeToolResultText,
    readOnlyClaudeTools,
    type ClaudeToolDescription,
} from './claude-items.js';
import {type ProviderAdapter, type ProviderSink} from './provider-session.js';

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
        push(text: string) {
            state.messages.push({
                type: 'user',
                message: {
                    role: 'user',
                    content: text,
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
                },
            });
            try {
                return (await claudeQuery.supportedModels()).map((model) => {
                    return {
                        id: model.value,
                        name: model.displayName,
                        description: model.description,
                        /** Claude Code lists its default model under the value `default`. */
                        isDefault: model.value === 'default',
                        supportedEfforts: model.supportsEffort
                            ? parseReasoningEfforts(model.supportedEffortLevels)
                            : [],
                    };
                });
            } finally {
                prompt.close();
                claudeQuery.close();
            }
        },
        start({cwd, model, effort, runtimeMode, providerSessionId, sink}) {
            const state = {
                runtimeMode,
                /** The id of the message the stream events currently belong to. */
                streamMessageId: '',
                /** How many content blocks each message's `assistant` messages have carried. */
                blockCounts: new Map<string, number>(),
                toolItems: new Map<string, ClaudeToolDescription>(),
                declinedToolIds: new Set<string>(),
                sessionApprovals: new Set<string>(),
                wasInterrupted: false,
                isStopped: false,
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

            const canUseTool: CanUseTool = async (toolName, input, {signal, toolUseID, title}) => {
                const approvalKey = createApprovalKey(toolName, input);
                if (
                    readOnlyClaudeTools.includes(toolName) ||
                    state.sessionApprovals.has(approvalKey)
                ) {
                    return {
                        behavior: 'allow',
                        updatedInput: input,
                    };
                }
                const tool = describeClaudeToolUse({
                    name: toolName,
                    input,
                });
                const decision = await sink.requestApproval(
                    {
                        kind: claudeApprovalKinds[tool.kind],
                        title: tool.title || toolName,
                        detail: tool.text,
                        reason: title || '',
                    },
                    signal,
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
            };

            const claudeQuery = query({
                prompt: messages,
                options: {
                    cwd,
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
                    ...(providerSessionId
                        ? {
                              resume: providerSessionId,
                          }
                        : {}),
                    sessionStore,
                    includePartialMessages: true,
                    /** Overrides a `defaultMode` in the user's settings. */
                    permissionMode: claudePermissionModes[runtimeMode],
                    /** Lets the thread switch to Full access later without a restart. */
                    allowDangerouslySkipPermissions: true,
                    canUseTool,
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
                if ('parent_tool_use_id' in message && message.parent_tool_use_id) {
                    /** A sub-agent's own steps, which its `Task` tool call already stands for. */
                    return;
                }
                if (message.type === 'system') {
                    if (message.subtype === 'init') {
                        await sink.setProviderSessionId(message.session_id);
                    } else if (message.subtype === 'mirror_error') {
                        await sink.addNotice(`Saving the transcript failed: ${message.error}`);
                    }
                } else if (message.type === 'stream_event') {
                    await handleStreamEvent(message.event);
                } else if (message.type === 'assistant') {
                    await handleAssistantMessage(message.message);
                } else if (message.type === 'user') {
                    await handleToolResults(message.message.content);
                } else if (message.type === 'result') {
                    if (message.subtype === 'success' || state.wasInterrupted) {
                        await sink.setStatus(ThreadStatus.Idle);
                    } else {
                        await sink.addNotice(
                            message.errors.join('\n') || `Claude stopped: ${message.subtype}.`,
                        );
                        await sink.setStatus(ThreadStatus.Failed);
                    }
                    state.wasInterrupted = false;
                }
            }

            async function handleStreamEvent(
                event: Extract<SDKMessage, {type: 'stream_event'}>['event'],
            ) {
                if (event.type === 'message_start') {
                    state.streamMessageId = event.message.id;
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
                            const tool = check.isString(toolUseId)
                                ? state.toolItems.get(toolUseId)
                                : undefined;
                            if (
                                block.type !== 'tool_result' ||
                                !check.isString(toolUseId) ||
                                !tool
                            ) {
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
                                providerItemId: toolUseId,
                            });
                        }),
                );
            }

            async function readMessages(sessionSink: ProviderSink) {
                try {
                    for await (const message of claudeQuery) {
                        await handleMessage(message);
                    }
                } catch (error) {
                    if (!state.isStopped) {
                        await sessionSink.addNotice(`Claude failed: ${extractErrorMessage(error)}`);
                        await sessionSink.setStatus(ThreadStatus.Failed);
                    }
                } finally {
                    sessionSink.endSession();
                }
            }

            void readMessages(sink);

            return Promise.resolve({
                send(text) {
                    messages.push(text);
                },
                async interrupt() {
                    state.wasInterrupted = true;
                    await claudeQuery.interrupt();
                },
                async setRuntimeMode(newRuntimeMode) {
                    state.runtimeMode = newRuntimeMode;
                    await claudeQuery.setPermissionMode(claudePermissionModes[newRuntimeMode]);
                },
                stop() {
                    state.isStopped = true;
                    messages.close();
                    claudeQuery.close();
                },
            });
        },
    };
}
