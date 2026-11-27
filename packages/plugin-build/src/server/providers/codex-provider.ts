// cspell:word cwds
import {convertDuration} from 'date-vir';
import {sep} from 'node:path';
import {
    assertValidShape,
    checkValidShape,
    defineShape,
    nullableShape,
    optionalShape,
    unknownShape,
} from 'object-shape-tester';
import {
    ApprovalDecision,
    ApprovalKind,
    ComposerCommandKind,
    ComposerCommandSource,
    RuntimeMode,
    ThreadItemKind,
    ThreadStatus,
} from '../../build-api.js';
import {parseReasoningEffort, parseReasoningEfforts} from '../../util/reasoning-effort.js';
import {agentToolServerName, agentToolTimeout} from '../agent-tool-server.js';
import {syncedSkillsFolder} from './claude-commands.js';
import {codexDecisions, describeCodexItem, readCodexTokenUsage} from './codex-items.js';
import {findLegacyCodexModelIds} from './codex-models.js';
import {startCodexRpc, type CodexRpc} from './codex-rpc.js';
import {
    type ProviderAdapter,
    type ProviderItem,
    type ProviderSession,
    type SessionModelSettings,
} from './provider-session.js';

const threadResponseShape = defineShape({
    thread: {
        id: '',
    },
    /** The model the thread runs, which names the default model when none was picked. */
    model: optionalShape(nullableShape(''), {
        alsoUndefined: true,
    }),
});

const turnResponseShape = defineShape({
    turn: {
        id: '',
    },
});

const itemNotificationShape = defineShape({
    item: {
        id: '',
    },
});

const deltaNotificationShape = defineShape({
    itemId: '',
    delta: '',
});

const turnNotificationShape = defineShape({
    turn: {
        id: '',
        status: '',
        error: optionalShape(
            nullableShape(
                defineShape({
                    message: '',
                }),
            ),
            {
                alsoUndefined: true,
            },
        ),
    },
});

/** The turn an item or delta notification belongs to. */
const turnIdParamsShape = defineShape({
    turnId: '',
});

const errorNotificationShape = defineShape({
    error: {
        message: '',
    },
    willRetry: false,
});

const approvalRequestShape = defineShape({
    itemId: '',
    command: optionalShape(nullableShape(''), {
        alsoUndefined: true,
    }),
    reason: optionalShape(nullableShape(''), {
        alsoUndefined: true,
    }),
});

/** An MCP elicitation Codex sends to ask before running an MCP tool. */
const mcpToolApprovalRequestShape = defineShape({
    serverName: '',
    _meta: {
        codex_approval_kind: '',
        tool_name: '',
        tool_params: unknownShape(),
    },
});

/** Codex's answer to an MCP tool's approval for each decision. */
const codexMcpToolDecisions: Readonly<Record<ApprovalDecision, Readonly<Record<string, unknown>>>> =
    {
        [ApprovalDecision.Approve]: {
            action: 'accept',
            content: {},
        },
        [ApprovalDecision.ApproveForSession]: {
            action: 'accept',
            content: {},
            _meta: {
                persist: 'session',
            },
        },
        [ApprovalDecision.Decline]: {
            action: 'decline',
        },
    };

const modelListResponseShape = defineShape({
    data: [
        {
            model: '',
            displayName: '',
            description: '',
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: '',
            supportedReasoningEfforts: [
                {
                    reasoningEffort: '',
                },
            ],
            serviceTiers: optionalShape(
                [
                    {
                        id: '',
                        name: '',
                    },
                ],
                {
                    alsoUndefined: true,
                },
            ),
        },
    ],
});

const skillListResponseShape = defineShape({
    data: [
        {
            skills: [
                {
                    name: '',
                    description: '',
                    shortDescription: nullableShape(''),
                    path: '',
                    scope: '',
                    enabled: false,
                    pluginId: nullableShape(''),
                },
            ],
        },
    ],
});

/** Where each of Codex's skill scopes is defined. */
const codexSkillSources: Readonly<Record<string, ComposerCommandSource>> = {
    repo: ComposerCommandSource.Repo,
    user: ComposerCommandSource.Personal,
    system: ComposerCommandSource.BuiltIn,
};

const extraKeys = {
    allowExtraKeys: true,
};

export async function initializeCodexRpc(rpc: Readonly<CodexRpc>) {
    await rpc.request('initialize', {
        clientInfo: {
            name: 'agent-storm',
            title: 'Agent Storm',
            version: '0.0.0',
        },
        capabilities: null,
    });
    rpc.notify('initialized');
}

const workspaceWriteSandbox = {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
};

/** The approval and sandbox settings `turn/start` takes for each runtime mode. */
const codexRuntimeModes: Readonly<
    Record<
        RuntimeMode,
        Readonly<{
            approvalPolicy: string;
            approvalsReviewer: string;
            sandboxPolicy: Readonly<Record<string, unknown>>;
        }>
    >
> = {
    [RuntimeMode.Supervised]: {
        /** `untrusted` asks even before running `cat`. */
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
            type: 'readOnly',
            networkAccess: false,
        },
    },
    [RuntimeMode.AutoAcceptEdits]: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: workspaceWriteSandbox,
    },
    [RuntimeMode.Auto]: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: workspaceWriteSandbox,
    },
    [RuntimeMode.FullAccess]: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: {
            type: 'dangerFullAccess',
        },
    },
};

/**
 * Runs Codex through `codex app-server`. The thread's runtime mode sets Codex's sandbox and when it
 * asks, from the next turn on.
 */
export const codexProvider: ProviderAdapter = {
    async listModels({cwd}) {
        const rpc = await startCodexRpc({
            cwd,
            onNotification() {},
            onRequest(method) {
                throw new Error(`Agent Storm doesn't support Codex's ${method} request.`);
            },
            onExit() {},
        });
        try {
            await initializeCodexRpc(rpc);
            const response = await rpc.request('model/list', {
                limit: 100,
            });
            assertValidShape(response, modelListResponseShape, extraKeys);
            const visibleModels = response.data.filter((model) => !model.hidden);
            const legacyModelIds = findLegacyCodexModelIds(
                visibleModels.map((model) => model.model),
            );
            return visibleModels.map((model) => {
                return {
                    id: model.model,
                    name: model.displayName,
                    description: model.description,
                    isDefault: model.isDefault,
                    isLegacy: legacyModelIds.includes(model.model),
                    supportedEfforts: parseReasoningEfforts(
                        model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
                    ),
                    defaultEffort: parseReasoningEffort(model.defaultReasoningEffort),
                    speedTiers: (model.serviceTiers || []).map((tier) => {
                        return {
                            id: tier.id,
                            name: tier.name,
                        };
                    }),
                };
            });
        } finally {
            rpc.stop();
        }
    },
    /** Codex's own slash commands aren't listed: it reads them only from its terminal UI. */
    async listCommands({cwd}) {
        const rpc = await startCodexRpc({
            cwd,
            onNotification() {},
            onRequest(method) {
                throw new Error(`Agent Storm doesn't support Codex's ${method} request.`);
            },
            onExit() {},
        });
        try {
            await initializeCodexRpc(rpc);
            const response = await rpc.request('skills/list', {
                cwds: [
                    cwd,
                ],
            });
            assertValidShape(response, skillListResponseShape, extraKeys);
            return (
                response.data
                    .flatMap((entry) => entry.skills)
                    /** Codex lists a skill once per folder it finds a copy in. */
                    .filter((skill, index, skills) => {
                        return (
                            skill.enabled &&
                            skills.findIndex((other) => other.name === skill.name) === index
                        );
                    })
                    .map((skill) => {
                        return {
                            name: skill.name,
                            description: skill.shortDescription || skill.description,
                            argumentHint: '',
                            kind: ComposerCommandKind.Skill,
                            source: skill.pluginId
                                ? ComposerCommandSource.Plugin
                                : skill.path.includes(
                                        `${sep}skills${sep}${syncedSkillsFolder}${sep}`,
                                    )
                                  ? ComposerCommandSource.Synced
                                  : codexSkillSources[skill.scope] || ComposerCommandSource.Other,
                        };
                    })
            );
        } finally {
            rpc.stop();
        }
    },
    async generateTitle({cwd, model, prompt}) {
        const reply = {
            text: '',
        };
        const turn = Promise.withResolvers<void>();
        const rpc = await startCodexRpc({
            cwd,
            onNotification(method, params) {
                if (
                    method === 'item/agentMessage/delta' &&
                    checkValidShape(params, deltaNotificationShape, extraKeys)
                ) {
                    reply.text += params.delta;
                } else if (method === 'turn/completed') {
                    turn.resolve();
                }
            },
            onRequest(method) {
                throw new Error(`Agent Storm doesn't support Codex's ${method} request.`);
            },
            onExit(reason) {
                turn.reject(new Error(reason));
            },
        });
        try {
            await initializeCodexRpc(rpc);
            const threadResponse = await rpc.request('thread/start', {
                cwd,
                model: model || null,
                ephemeral: true,
            });
            assertValidShape(threadResponse, threadResponseShape, extraKeys);
            await rpc.request('turn/start', {
                threadId: threadResponse.thread.id,
                approvalPolicy: 'never',
                sandboxPolicy: {
                    type: 'readOnly',
                    networkAccess: false,
                },
                effort: 'low',
                input: [
                    {
                        type: 'text',
                        text: prompt,
                        text_elements: [],
                    },
                ],
            });
            await turn.promise;
            return reply.text;
        } finally {
            rpc.stop();
        }
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
        apiKey,
        processHost,
    }) {
        const state: {
            runtimeMode: RuntimeMode;
            turnId: string | undefined;
            isStopped: boolean;
            /** The latest description of each item, which a file change's approval shows. */
            items: Map<string, ProviderItem>;
            /** Codex takes these per turn, so a change mid-turn applies from the next message. */
            modelSettings: SessionModelSettings;
            /**
             * The model Codex said the thread runs when it started it, for usage while no model is
             * picked. Empty for a process taken over from before a restart, which said it then.
             */
            startedModel: string;
        } = {
            runtimeMode,
            modelSettings: {
                model,
                effort,
                speedTier,
            },
            turnId: undefined,
            isStopped: false,
            items: new Map(),
            startedModel: '',
        };
        const notificationHandlers: Readonly<
            Record<string, (params: unknown) => Promise<void> | void>
        > = {
            async 'item/started'(params) {
                await putItem(params, false);
            },
            async 'item/completed'(params) {
                await putItem(params, true);
            },
            'turn/started'(params) {
                if (checkValidShape(params, turnNotificationShape, extraKeys)) {
                    state.turnId = params.turn.id;
                }
            },
            async 'turn/completed'(params) {
                if (!checkValidShape(params, turnNotificationShape, extraKeys)) {
                    return;
                }
                state.turnId = undefined;
                if (params.turn.status === 'failed') {
                    await sink.addNotice(params.turn.error?.message || 'Codex failed the turn.');
                    await sink.setStatus(ThreadStatus.Failed);
                } else {
                    await sink.setStatus(ThreadStatus.Idle);
                }
            },
            async error(params) {
                if (
                    checkValidShape(params, errorNotificationShape, extraKeys) &&
                    !params.willRetry
                ) {
                    await sink.addNotice(params.error.message);
                }
            },
            async 'thread/tokenUsage/updated'(params) {
                const usage = readCodexTokenUsage({
                    params,
                    model: state.modelSettings.model || state.startedModel || 'codex',
                });
                if (usage) {
                    await sink.recordUsage(usage);
                }
            },
            'account/rateLimits/updated'() {
                sink.reportRateLimitsChanged();
            },
            'item/agentMessage/delta': appendDelta,
            'item/reasoning/summaryTextDelta': appendDelta,
            'item/commandExecution/outputDelta': appendDelta,
            'item/plan/delta': appendDelta,
        };

        function appendDelta(params: unknown) {
            if (checkValidShape(params, deltaNotificationShape, extraKeys)) {
                sink.appendDelta({
                    providerItemId: params.itemId,
                    delta: params.delta,
                });
            }
        }

        async function reportExit(reason: string) {
            await sink.addNotice(reason);
            await sink.setStatus(ThreadStatus.Failed);
        }

        async function putItem(params: unknown, isCompleted: boolean) {
            if (!checkValidShape(params, itemNotificationShape, extraKeys)) {
                return;
            }
            const item = describeCodexItem({
                item: params.item,
                isCompleted,
            });
            if (item) {
                state.items.set(item.providerItemId, item);
                await sink.putItem(item);
            }
        }

        const requestHandlers: Readonly<Record<string, (params: unknown) => Promise<unknown>>> = {
            async 'item/commandExecution/requestApproval'(params) {
                assertValidShape(params, approvalRequestShape, extraKeys);
                const command =
                    params.command || state.items.get(params.itemId)?.title || 'A command';
                return {
                    decision:
                        codexDecisions[
                            await sink.requestApproval({
                                kind: ApprovalKind.Command,
                                title: command,
                                detail: command,
                                reason: params.reason || '',
                            })
                        ],
                };
            },
            async 'item/fileChange/requestApproval'(params) {
                assertValidShape(params, approvalRequestShape, extraKeys);
                const item = state.items.get(params.itemId);
                return {
                    decision:
                        codexDecisions[
                            await sink.requestApproval({
                                kind: ApprovalKind.FileChange,
                                title: item?.title || 'A file change',
                                detail: item?.kind === ThreadItemKind.FileChange ? item.text : '',
                                reason: params.reason || '',
                            })
                        ],
                };
            },
            async 'mcpServer/elicitation/request'(params) {
                if (
                    !checkValidShape(params, mcpToolApprovalRequestShape, extraKeys) ||
                    params._meta.codex_approval_kind !== 'mcp_tool_call'
                ) {
                    /** Agent Storm shows Codex's MCP tool approvals, not a server's own forms. */
                    return {
                        action: 'cancel',
                    };
                }
                return codexMcpToolDecisions[
                    await sink.requestApproval({
                        kind: ApprovalKind.Permission,
                        title: `${params.serverName}.${params._meta.tool_name}`,
                        detail: JSON.stringify(params._meta.tool_params, undefined, 4),
                        reason: '',
                    })
                ];
            },
        };

        const rpc = await startCodexRpc({
            cwd,
            env,
            isAuthEphemeral: !!apiKey,
            processHost,
            async onNotification(method, params) {
                /** Codex taken over mid-turn only names the turn in what it sends next. */
                if (
                    !state.turnId &&
                    method !== 'turn/completed' &&
                    checkValidShape(params, turnIdParamsShape, extraKeys)
                ) {
                    state.turnId = params.turnId;
                }
                await notificationHandlers[method]?.(params);
            },
            async onRequest(method, params) {
                const handler = requestHandlers[method];
                if (!handler) {
                    throw new Error(`Agent Storm doesn't support Codex's ${method} request.`);
                }
                return await handler(params);
            },
            onExit(reason) {
                sink.endSession();
                /** An idle process that exits cost no work, and the next message starts a new one. */
                if (!state.isStopped && state.turnId) {
                    void reportExit(reason);
                }
            },
        });

        try {
            if (!rpc.isNew && providerSessionId) {
                /** Already initialized, with the thread loaded, by the server before a restart. */
                return createSession(providerSessionId);
            }
            await initializeCodexRpc(rpc);
            /** `codex app-server` ignores `CODEX_API_KEY` and `OPENAI_API_KEY`. */
            if (apiKey) {
                await rpc.request('account/login/start', {
                    type: 'apiKey',
                    apiKey,
                });
            }
            const threadOptions = {
                cwd,
                model: model || null,
                config: {
                    [`mcp_servers.${agentToolServerName}`]: {
                        url: agentTools.url,
                        http_headers: {
                            Authorization: `Bearer ${agentTools.token}`,
                        },
                        tool_timeout_sec: convertDuration(agentToolTimeout, {
                            seconds: true,
                        }).seconds,
                    },
                },
            };
            const threadResponse = await rpc.request(
                providerSessionId ? 'thread/resume' : 'thread/start',
                providerSessionId
                    ? {
                          ...threadOptions,
                          threadId: providerSessionId,
                      }
                    : threadOptions,
            );
            assertValidShape(threadResponse, threadResponseShape, extraKeys);
            state.startedModel = threadResponse.model || '';
            await sink.setProviderSessionId(threadResponse.thread.id);
            return createSession(threadResponse.thread.id);
        } catch (error) {
            state.isStopped = true;
            rpc.stop();
            throw error;
        }

        function createSession(codexThreadId: string): ProviderSession {
            return {
                async send({text}) {
                    const turnResponse = await rpc.request('turn/start', {
                        threadId: codexThreadId,
                        ...codexRuntimeModes[state.runtimeMode],
                        serviceTier: state.modelSettings.speedTier || 'default',
                        ...(state.modelSettings.model
                            ? {
                                  model: state.modelSettings.model,
                              }
                            : {}),
                        ...(state.modelSettings.effort
                            ? {
                                  effort: state.modelSettings.effort,
                              }
                            : {}),
                        input: [
                            {
                                type: 'text',
                                text,
                                text_elements: [],
                            },
                        ],
                    });
                    assertValidShape(turnResponse, turnResponseShape, extraKeys);
                    state.turnId = turnResponse.turn.id;
                },
                setRuntimeMode(newRuntimeMode) {
                    state.runtimeMode = newRuntimeMode;
                },
                setModel(settings) {
                    state.modelSettings = settings;
                },
                async interrupt() {
                    if (state.turnId) {
                        await rpc.request('turn/interrupt', {
                            threadId: codexThreadId,
                            turnId: state.turnId,
                        });
                    }
                },
                stop() {
                    state.isStopped = true;
                    rpc.stop();
                },
            };
        }
    },
};
