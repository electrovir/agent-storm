import {
    assertValidShape,
    checkValidShape,
    defineShape,
    nullableShape,
    optionalShape,
} from 'object-shape-tester';
import {ApprovalKind, RuntimeMode, ThreadItemKind, ThreadStatus} from '../../build-v2-api.js';
import {parseReasoningEffort, parseReasoningEfforts} from '../../util/reasoning-effort.js';
import {codexDecisions, describeCodexItem} from './codex-items.js';
import {startCodexRpc, type CodexRpc} from './codex-rpc.js';
import {type ProviderAdapter, type ProviderItem} from './provider-session.js';

const threadResponseShape = defineShape({
    thread: {
        id: '',
    },
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
        },
    ],
});

const extraKeys = {
    allowExtraKeys: true,
};

async function initializeCodexRpc(rpc: Readonly<CodexRpc>) {
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
        const rpc = startCodexRpc({
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
            return response.data
                .filter((model) => !model.hidden)
                .map((model) => {
                    return {
                        id: model.model,
                        name: model.displayName,
                        description: model.description,
                        isDefault: model.isDefault,
                        supportedEfforts: parseReasoningEfforts(
                            model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
                        ),
                        defaultEffort: parseReasoningEffort(model.defaultReasoningEffort),
                    };
                });
        } finally {
            rpc.stop();
        }
    },
    async start({cwd, model, effort, runtimeMode, providerSessionId, sink}) {
        const state: {
            runtimeMode: RuntimeMode;
            turnId: string | undefined;
            isStopped: boolean;
            /** The latest description of each item, which a file change's approval shows. */
            items: Map<string, ProviderItem>;
        } = {
            runtimeMode,
            turnId: undefined,
            isStopped: false,
            items: new Map(),
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
        };

        const rpc = startCodexRpc({
            cwd,
            async onNotification(method, params) {
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
                if (!state.isStopped) {
                    void reportExit(reason);
                }
            },
        });

        try {
            await initializeCodexRpc(rpc);
            const threadOptions = {
                cwd,
                model: model || null,
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
            const codexThreadId = threadResponse.thread.id;
            await sink.setProviderSessionId(codexThreadId);

            return {
                async send(text) {
                    const turnResponse = await rpc.request('turn/start', {
                        threadId: codexThreadId,
                        ...codexRuntimeModes[state.runtimeMode],
                        ...(effort
                            ? {
                                  effort,
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
        } catch (error) {
            state.isStopped = true;
            rpc.stop();
            throw error;
        }
    },
};
