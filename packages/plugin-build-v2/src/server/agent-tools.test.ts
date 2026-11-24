import {folderInfoShape} from '@agent-storm/common';
import {type PluginCallHandlers} from '@agent-storm/core/server';
import {assert, assertWrap} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    AiProvider,
    ApprovalDecision,
    type buildV2Api,
    ReasoningEffort,
    RuntimeMode,
    type Thread,
    ThreadOrigin,
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
    isPriority: false,
    isAskingQuestion: false,
    backgroundTaskCount: 0,
    origin: ThreadOrigin.User,
    userMessageCount: 0,
    lastUserMessageAt: 0,
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
                sideChats: [],
                paneThreads: [],
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
        moveToFolder(request) {
            requests.push({
                call: 'moveToFolder',
                request,
            });
            return {
                thread: {
                    ...baseThread,
                    cwd: request.folder,
                },
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
        requestApproval({signal, ...request}) {
            requests.push({
                call: 'requestApproval',
                request,
            });
            return Promise.resolve(ApprovalDecision.Approve);
        },
        showImages(request) {
            requests.push({
                call: 'showImages',
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
        signal: new AbortController().signal,
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
                    isSidebarThread: true,
                },
            },
        ]);
    });

    it('starts at standard speed even when the caller is in fast mode', async () => {
        const {context, requests} = createTestContext([
            {
                ...baseThread,
                speedTier: 'fast',
            },
        ]);
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
                    speedTier: null,
                    runtimeMode: baseThread.runtimeMode,
                    text: 'Fix the build.',
                    isInWorktree: false,
                    isStartAwaited: true,
                    isSidebarThread: true,
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
    it('asks the user, moves only once the turn ends, then sends the continuation prompt', async () => {
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
                callsDuringTurn: [
                    'requestApproval',
                ],
                callsAfterTurn: [
                    'requestApproval',
                    'moveToWorktree',
                    'sendMessage',
                ],
            },
        );
    });

    it('skips asking when the user already asked for a worktree', async () => {
        const {context, requests, afterTurnActions} = createTestContext();
        await runTool({
            name: 'move_to_worktree',
            input: {
                isRequestedByUser: true,
            },
            context,
        });
        await Promise.all(afterTurnActions.map(async (action) => await action()));
        assert.deepEquals(
            requests.map(({call}) => call),
            [
                'moveToWorktree',
            ],
        );
    });

    it('stays put when the user declines', async () => {
        const {context, afterTurnActions} = createTestContext();
        await assert.throws(
            runTool({
                name: 'move_to_worktree',
                input: {},
                context: {
                    ...context,
                    requestApproval() {
                        return Promise.resolve(ApprovalDecision.Decline);
                    },
                },
            }),
            {
                matchMessage: 'declined',
            },
        );
        assert.isEmpty(afterTurnActions);
    });
});

describe('move_to_folder', () => {
    const listedFolder = {
        ...folderInfoShape.default,
        path: '/repos/other',
    };

    it("refuses a folder that isn't in the sidebar", async () => {
        const {context, afterTurnActions} = createTestContext();
        await assert.throws(
            runTool({
                name: 'move_to_folder',
                input: {
                    folder: '/repos/unknown',
                },
                context: {
                    ...context,
                    listFolders() {
                        return Promise.resolve([
                            listedFolder,
                        ]);
                    },
                },
            }),
            {
                matchMessage: "isn't a folder",
            },
        );
        assert.isEmpty(afterTurnActions);
    });

    it('moves only once the turn ends', async () => {
        const {context, requests, afterTurnActions} = createTestContext();
        await runTool({
            name: 'move_to_folder',
            input: {
                folder: listedFolder.path,
            },
            context: {
                ...context,
                listFolders() {
                    return Promise.resolve([
                        listedFolder,
                    ]);
                },
            },
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
                        call: 'moveToFolder',
                        request: {
                            threadId: baseThread.id,
                            folder: listedFolder.path,
                        },
                    },
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
    it('archives this thread with its worktree only once the turn ends', async () => {
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
                            deleteWorktree: true,
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
