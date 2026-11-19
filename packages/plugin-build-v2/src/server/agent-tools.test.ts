import {type PluginCallHandlers} from '@agent-storm/core/server';
import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    AiProvider,
    type buildV2Api,
    ReasoningEffort,
    RuntimeMode,
    type Thread,
    ThreadStatus,
} from '../build-v2-api.js';
import {type AgentToolContext, agentTools} from './agent-tools.js';

const baseThread: Thread = {
    id: 'caller',
    repoPath: '/repos/example',
    cwd: '/repos/example',
    worktreeBranch: null,
    provider: AiProvider.Claude,
    model: 'claude-opus-5',
    effort: ReasoningEffort.High,
    speedTier: null,
    runtimeMode: RuntimeMode.AutoAcceptEdits,
    title: 'Caller',
    status: ThreadStatus.Running,
    hasUnreadReply: false,
    createdAt: 0,
    updatedAt: 0,
};

const otherThread: Thread = {
    ...baseThread,
    id: 'other',
    runtimeMode: RuntimeMode.FullAccess,
};

/** A context whose calls record their requests, with every after-turn action held for the test. */
function createTestContext(
    threads: ReadonlyArray<Thread> = [
        baseThread,
        otherThread,
    ],
) {
    const requests: {call: string; request: unknown}[] = [];
    const afterTurnActions: (() => Promise<void>)[] = [];
    const calls: Partial<PluginCallHandlers<typeof buildV2Api>> = {
        listThreads() {
            return {
                threads: [
                    ...threads,
                ],
                repoActivity: [],
            };
        },
        archiveThread(request) {
            requests.push({
                call: 'archiveThread',
                request,
            });
            return {
                ok: true,
            };
        },
        createThread(request) {
            requests.push({
                call: 'createThread',
                request,
            });
            return {
                thread: baseThread,
            };
        },
        moveToWorktree(request) {
            requests.push({
                call: 'moveToWorktree',
                request,
            });
            return {
                thread: {
                    ...baseThread,
                    cwd: '/repos/example-worktree',
                },
            };
        },
        sendMessage(request) {
            requests.push({
                call: 'sendMessage',
                request,
            });
            return {
                ok: true,
            };
        },
    };
    const context: AgentToolContext = {
        calls: calls satisfies Partial<PluginCallHandlers<typeof buildV2Api>> as PluginCallHandlers<
            typeof buildV2Api
        >,
        findThread(threadId) {
            return Promise.resolve(assertWrap.isDefined(threads.find(({id}) => id === threadId)));
        },
        listFolders() {
            return Promise.resolve([]);
        },
        deleteWorktree(request) {
            requests.push({
                call: 'deleteWorktree',
                request,
            });
            return Promise.resolve();
        },
        runAfterTurn(threadId, action) {
            afterTurnActions.push(action);
        },
    };
    return {
        context,
        requests,
        afterTurnActions,
    };
}

async function runTool({
    name,
    input,
    context,
}: Readonly<{name: string; input: unknown; context: AgentToolContext}>) {
    return await assertWrap.isDefined(agentTools.find((tool) => tool.name === name)).run({
        callerId: baseThread.id,
        input,
        context,
    });
}

describe('create_thread', () => {
    it("defaults to the caller's checkout, model, and runtime mode", async () => {
        const {context, requests} = createTestContext();
        await runTool({
            name: 'create_thread',
            input: {
                text: 'Fix the build.',
            },
            context,
        });
        assert.deepEquals(requests, [
            {
                call: 'createThread',
                request: {
                    repoPath: baseThread.repoPath,
                    provider: baseThread.provider,
                    model: baseThread.model,
                    effort: baseThread.effort,
                    speedTier: baseThread.speedTier,
                    runtimeMode: baseThread.runtimeMode,
                    text: 'Fix the build.',
                    isInWorktree: false,
                    isStartAwaited: true,
                },
            },
        ]);
    });

    it("refuses a runtime mode above the caller's", async () => {
        const {context, requests} = createTestContext();
        await assert.throws(
            runTool({
                name: 'create_thread',
                input: {
                    text: 'Fix the build.',
                    runtimeMode: RuntimeMode.FullAccess,
                },
                context,
            }),
            {
                matchMessage: 'asks the user less',
            },
        );
        assert.isEmpty(requests);
    });
});

describe('send_to_thread', () => {
    it('refuses the calling thread', async () => {
        const {context} = createTestContext();
        await assert.throws(
            runTool({
                name: 'send_to_thread',
                input: {
                    threadId: baseThread.id,
                    text: 'Hello.',
                },
                context,
            }),
            {
                matchMessage: 'other threads only',
            },
        );
    });

    it("refuses a thread in a mode above the caller's", async () => {
        const {context} = createTestContext();
        await assert.throws(
            runTool({
                name: 'send_to_thread',
                input: {
                    threadId: otherThread.id,
                    text: 'Hello.',
                },
                context,
            }),
            {
                matchMessage: 'asks the user less',
            },
        );
    });
});

describe('interrupt_thread', () => {
    it("refuses a thread in a mode above the caller's", async () => {
        const {context} = createTestContext();
        await assert.throws(
            runTool({
                name: 'interrupt_thread',
                input: {
                    threadId: otherThread.id,
                },
                context,
            }),
            {
                matchMessage: 'asks the user less',
            },
        );
    });
});

describe('move_to_worktree', () => {
    it('moves only once the turn ends, then sends the continuation prompt', async () => {
        const {context, requests, afterTurnActions} = createTestContext();
        await runTool({
            name: 'move_to_worktree',
            input: {
                continuationPrompt: 'Carry on.',
            },
            context,
        });
        const callsDuringTurn = requests.map(({call}) => call);
        await Promise.all(afterTurnActions.map(async (action) => await action()));
        assert.deepEquals(
            {
                callsDuringTurn,
                callsAfterTurn: requests.map(({call}) => call),
            },
            {
                callsDuringTurn: [],
                callsAfterTurn: [
                    'moveToWorktree',
                    'sendMessage',
                ],
            },
        );
    });
});

const worktreeThread: Thread = {
    ...baseThread,
    cwd: '/repos/example-worktree',
    worktreeBranch: 'example-worktree',
};

describe('archive_thread', () => {
    it('archives this thread and deletes its worktree only once the turn ends', async () => {
        const {context, requests, afterTurnActions} = createTestContext([
            worktreeThread,
            otherThread,
        ]);
        await runTool({
            name: 'archive_thread',
            input: {
                deleteWorktree: true,
            },
            context,
        });
        const callsDuringTurn = requests.map(({call}) => call);
        await Promise.all(afterTurnActions.map(async (action) => await action()));
        assert.deepEquals(
            {
                callsDuringTurn,
                requestsAfterTurn: requests,
            },
            {
                callsDuringTurn: [],
                requestsAfterTurn: [
                    {
                        call: 'archiveThread',
                        request: {
                            threadId: worktreeThread.id,
                        },
                    },
                    {
                        call: 'deleteWorktree',
                        request: {
                            worktreePath: worktreeThread.cwd,
                        },
                    },
                ],
            },
        );
    });

    it('refuses to delete a worktree another thread works in', async () => {
        const {context} = createTestContext([
            worktreeThread,
            {
                ...otherThread,
                cwd: worktreeThread.cwd,
            },
        ]);
        await assert.throws(
            runTool({
                name: 'archive_thread',
                input: {
                    deleteWorktree: true,
                },
                context,
            }),
            {
                matchMessage: 'Another thread works in',
            },
        );
    });

    it("refuses another thread in a mode above the caller's", async () => {
        const {context, requests} = createTestContext();
        await assert.throws(
            runTool({
                name: 'archive_thread',
                input: {
                    threadId: otherThread.id,
                },
                context,
            }),
            {
                matchMessage: 'asks the user less',
            },
        );
        assert.isEmpty(requests);
    });
});
