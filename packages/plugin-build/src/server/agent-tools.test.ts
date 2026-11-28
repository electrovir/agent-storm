import {type FolderInfo, folderInfoShape} from '@agent-storm/common';
import {type PluginCallHandlers} from '@agent-storm/core/server';
import {assert, assertWrap} from '@augment-vir/assert';
import {selectFrom} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {
    AiProvider,
    ApprovalDecision,
    type buildApi,
    ReasoningEffort,
    RuntimeMode,
    type Thread,
    ThreadOrigin,
    ThreadStatus,
} from '../build-api.js';
import {type AgentToolContext, agentTools, MoveToWorktreeOutcome} from './agent-tools.js';

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
    const calls: Partial<PluginCallHandlers<typeof buildApi>> = {
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
                thread: {
                    ...baseThread,
                    id: 'created',
                    cwd: '/repos/created-worktree',
                    worktreeBranch: request.branchName || 'created-worktree',
                },
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
        calls: calls satisfies Partial<PluginCallHandlers<typeof buildApi>> as PluginCallHandlers<
            typeof buildApi
        >,
        findThread(threadId) {
            return Promise.resolve(assertWrap.isDefined(threads.find(({id}) => id === threadId)));
        },
        isThreadActive(threadId) {
            return Promise.resolve(threads.some(({id}) => id === threadId));
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
        showFile(request) {
            requests.push({
                call: 'showFile',
                request,
            });
            return Promise.resolve(request.path);
        },
        findReviewSkill() {
            return Promise.resolve('');
        },
        countCommitsPastDefaultBranch() {
            return Promise.resolve(0);
        },
        renamePlaceholderBranch(request) {
            requests.push({
                call: 'renamePlaceholderBranch',
                request,
            });
            return Promise.resolve(true);
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
                    branchName: undefined,
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
                    branchName: undefined,
                    isStartAwaited: true,
                    isSidebarThread: true,
                },
            },
        ]);
    });

    it("refuses a folder that isn't in the sidebar", async () => {
        const {context, requests} = createTestContext();
        await assert.throws(
            runTool({
                name: 'create_thread',
                input: {
                    text: 'Post the review.',
                    repoPath: '/review-copies/example/6600',
                },
                context,
            }),
            {
                matchMessage: "isn't a folder in Agent Storm's sidebar",
            },
        );
        assert.isEmpty(requests);
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

    it('branches from a worktree of the same repo when given a base folder', async () => {
        const {context, requests, afterTurnActions} = createTestContext();
        await runTool({
            name: 'move_to_worktree',
            input: {
                isRequestedByUser: true,
                baseFolder: '/repos/example-stacked',
                branchName: 'eng-12-fix-login',
            },
            context: {
                ...context,
                listFolders() {
                    return Promise.resolve([
                        {
                            ...folderInfoShape.default,
                            path: '/repos/example-stacked',
                            parentRepoPath: baseThread.repoPath,
                        },
                    ]);
                },
            },
        });
        await Promise.all(afterTurnActions.map(async (action) => await action()));
        assert.deepEquals(requests, [
            {
                call: 'moveToWorktree',
                request: {
                    threadId: baseThread.id,
                    baseFolder: '/repos/example-stacked',
                    branchName: 'eng-12-fix-login',
                },
            },
        ]);
    });

    it("refuses a base folder that isn't a worktree of this repo", async () => {
        const {context, afterTurnActions} = createTestContext();
        await assert.throws(
            runTool({
                name: 'move_to_worktree',
                input: {
                    isRequestedByUser: true,
                    baseFolder: '/repos/unknown',
                },
                context,
            }),
            {
                matchMessage: "isn't a worktree",
            },
        );
        assert.isEmpty(afterTurnActions);
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

    it("refuses a branchName that isn't a single folder name", async () => {
        const {context, afterTurnActions} = createTestContext();
        await assert.throws(
            runTool({
                name: 'move_to_worktree',
                input: {
                    isRequestedByUser: true,
                    branchName: 'someone/eng-12-fix-login',
                },
                context,
            }),
            {
                matchMessage: 'only letters, digits',
            },
        );
        assert.isEmpty(afterTurnActions);
    });

    describe('from a worktree', () => {
        /** A worktree made outside Agent Storm, such as by a worktree skill. */
        const skillThread: Thread = {
            ...baseThread,
            cwd: '/repos/example-skill-worktree',
        };
        const freshFolder: FolderInfo = {
            ...folderInfoShape.default,
            path: skillThread.cwd,
            name: 'example-skill-worktree',
            parentRepoPath: baseThread.repoPath,
            branch: 'example-skill-worktree',
            git: {
                dirty: false,
                notPushed: false,
            },
            prUrl: null,
        };

        function createWorktreeContext({
            folder = freshFolder,
            commitCount = 0,
        }: Readonly<{folder?: FolderInfo; commitCount?: number}> = {}) {
            const testContext = createTestContext([
                skillThread,
            ]);
            return {
                ...testContext,
                context: {
                    ...testContext.context,
                    listFolders() {
                        return Promise.resolve([
                            folder,
                        ]);
                    },
                    countCommitsPastDefaultBranch() {
                        return Promise.resolve(commitCount);
                    },
                } satisfies AgentToolContext,
            };
        }

        it('stays in a worktree with no work yet and renames its branch', async () => {
            const {context, requests, afterTurnActions} = createWorktreeContext();
            const result = await runTool({
                name: 'move_to_worktree',
                input: {
                    branchName: 'eng-12-fix-login',
                },
                context,
            });
            assert.deepEquals(
                {
                    outcome: assertWrap.hasKey(result, 'outcome').outcome,
                    requests,
                    afterTurnActionCount: afterTurnActions.length,
                },
                {
                    outcome: MoveToWorktreeOutcome.StaysInFreshWorktree,
                    requests: [
                        {
                            call: 'renamePlaceholderBranch',
                            request: {
                                threadId: skillThread.id,
                                branch: 'eng-12-fix-login',
                            },
                        },
                    ],
                    afterTurnActionCount: 0,
                },
            );
        });

        it('starts a new thread in a new worktree when this one has commits', async () => {
            const {context, requests, afterTurnActions} = createWorktreeContext({
                commitCount: 2,
            });
            const result = await runTool({
                name: 'move_to_worktree',
                input: {
                    isRequestedByUser: true,
                    continuationPrompt: 'Fix the login page.',
                    branchName: 'eng-12-fix-login',
                },
                context,
            });
            assert.deepEquals(
                {
                    result: selectFrom(
                        assertWrap.hasKeys(result, [
                            'outcome',
                            'threadId',
                            'folder',
                        ]),
                        {
                            outcome: true,
                            threadId: true,
                            folder: true,
                        },
                    ),
                    requests,
                    afterTurnActionCount: afterTurnActions.length,
                },
                {
                    result: {
                        outcome: MoveToWorktreeOutcome.StartedNewThread,
                        threadId: 'created',
                        folder: '/repos/created-worktree',
                    },
                    requests: [
                        {
                            call: 'createThread',
                            request: {
                                repoPath: baseThread.repoPath,
                                provider: skillThread.provider,
                                model: skillThread.model,
                                effort: skillThread.effort,
                                speedTier: null,
                                runtimeMode: skillThread.runtimeMode,
                                text: 'Fix the login page.',
                                isInWorktree: true,
                                branchName: 'eng-12-fix-login',
                                isOpenWorktreeSkillSkipped: true,
                                isStartAwaited: true,
                                isSidebarThread: true,
                            },
                        },
                    ],
                    afterTurnActionCount: 0,
                },
            );
        });

        it('counts uncommitted changes and a PR as work', async () => {
            const outcomes = await Promise.all(
                [
                    {
                        ...freshFolder,
                        git: {
                            dirty: true,
                            notPushed: false,
                        },
                    },
                    {
                        ...freshFolder,
                        prUrl: 'https://github.com/example/example/pull/1',
                    },
                ].map(async (folder) => {
                    const result = await runTool({
                        name: 'move_to_worktree',
                        input: {
                            isRequestedByUser: true,
                            continuationPrompt: 'Fix the login page.',
                        },
                        context: createWorktreeContext({
                            folder,
                        }).context,
                    });
                    return assertWrap.hasKey(result, 'outcome').outcome;
                }),
            );
            assert.deepEquals(outcomes, [
                MoveToWorktreeOutcome.StartedNewThread,
                MoveToWorktreeOutcome.StartedNewThread,
            ]);
        });

        it('requires a continuation prompt to start a new thread', async () => {
            const {context, requests} = createWorktreeContext({
                commitCount: 1,
            });
            await assert.throws(
                runTool({
                    name: 'move_to_worktree',
                    input: {
                        isRequestedByUser: true,
                    },
                    context,
                }),
                {
                    matchMessage: 'continuationPrompt',
                },
            );
            assert.isEmpty(requests);
        });
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

    it('refuses to move a thread out of its own worktree', async () => {
        const {context, afterTurnActions} = createTestContext([
            {
                ...baseThread,
                worktreeBranch: 'example-worktree',
            },
        ]);
        await assert.throws(
            runTool({
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
            }),
            {
                matchMessage: 'create_thread',
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
