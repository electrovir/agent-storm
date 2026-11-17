// cspell:words seconddone
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    AiProvider,
    RuntimeMode,
    ThreadItemKind,
    ThreadItemStatus,
    ThreadStatus,
    type Thread,
    type ThreadItem,
} from '../build-v2-api.js';
import {
    applyItemDelta,
    buildTimeline,
    groupThreadsByRepo,
    summarizeWork,
    TimelineEntryKind,
    upsertItems,
    upsertThread,
} from './thread-timeline.js';

function createThread(overrides: Readonly<Partial<Thread>>): Thread {
    return {
        id: 'thread',
        repoPath: '/repos/app',
        cwd: '/repos/app',
        worktreeBranch: null,
        provider: AiProvider.Claude,
        model: '',
        runtimeMode: RuntimeMode.FullAccess,
        title: 'Thread',
        status: ThreadStatus.Idle,
        hasUnreadReply: false,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function createItem(overrides: Readonly<Partial<ThreadItem>>): ThreadItem {
    return {
        id: 'item',
        threadId: 'thread',
        turnId: 'turn',
        kind: ThreadItemKind.Command,
        status: ThreadItemStatus.Completed,
        title: '',
        text: '',
        order: 0,
        createdAt: 0,
        ...overrides,
    };
}

describe(groupThreadsByRepo.name, () => {
    it('orders repos by latest thread and keeps unlisted repos', () => {
        const groups = groupThreadsByRepo({
            repos: [
                {
                    path: '/repos/empty',
                    name: 'empty',
                },
                {
                    path: '/repos/app',
                    name: 'app',
                },
            ],
            threads: [
                createThread({
                    id: 'old',
                    updatedAt: 1,
                }),
                createThread({
                    id: 'new',
                    updatedAt: 3,
                }),
                createThread({
                    id: 'other',
                    repoPath: '/repos/gone',
                    updatedAt: 2,
                }),
            ],
        });

        assert.deepEquals(
            groups.map((group) => {
                return {
                    name: group.repo.name,
                    threadIds: group.threads.map((thread) => thread.id),
                };
            }),
            [
                {
                    name: 'app',
                    threadIds: [
                        'new',
                        'old',
                    ],
                },
                {
                    name: 'gone',
                    threadIds: [
                        'other',
                    ],
                },
                {
                    name: 'empty',
                    threadIds: [],
                },
            ],
        );
    });
});

describe(upsertThread.name, () => {
    it('replaces a known thread and prepends a new one', () => {
        const threads = [
            createThread({
                id: 'a',
            }),
        ];

        assert.deepEquals(
            upsertThread(
                upsertThread(
                    threads,
                    createThread({
                        id: 'a',
                        title: 'Renamed',
                    }),
                ),
                createThread({
                    id: 'b',
                }),
            ).map((thread) => thread.id + thread.title),
            [
                'bThread',
                'aRenamed',
            ],
        );
    });
});

describe(upsertItems.name, () => {
    it('replaces changed items and keeps timeline order', () => {
        const merged = upsertItems({
            items: [
                createItem({
                    id: 'first',
                    order: 1,
                }),
                createItem({
                    id: 'second',
                    order: 2,
                }),
            ],
            changedItems: [
                createItem({
                    id: 'zeroth',
                    order: 0,
                }),
                createItem({
                    id: 'second',
                    order: 2,
                    text: 'done',
                }),
            ],
        });

        assert.deepEquals(
            merged.map((item) => item.id + item.text),
            [
                'zeroth',
                'first',
                'seconddone',
            ],
        );
    });
});

describe(applyItemDelta.name, () => {
    it('appends to the matching item only', () => {
        assert.deepEquals(
            applyItemDelta(
                [
                    createItem({
                        id: 'a',
                        text: 'Hel',
                    }),
                    createItem({
                        id: 'b',
                        text: 'x',
                    }),
                ],
                {
                    itemId: 'a',
                    delta: 'lo',
                },
            ).map((item) => item.text),
            [
                'Hello',
                'x',
            ],
        );
    });
});

describe(buildTimeline.name, () => {
    it('folds consecutive work items into one entry', () => {
        const timeline = buildTimeline([
            createItem({
                id: 'ask',
                kind: ThreadItemKind.UserMessage,
            }),
            createItem({
                id: 'think',
                kind: ThreadItemKind.Reasoning,
            }),
            createItem({
                id: 'run',
                kind: ThreadItemKind.Command,
            }),
            createItem({
                id: 'answer',
                kind: ThreadItemKind.AssistantMessage,
            }),
            createItem({
                id: 'edit',
                kind: ThreadItemKind.FileChange,
            }),
        ]);

        assert.deepEquals(
            timeline.map((entry) => {
                return {
                    kind: entry.kind,
                    key: entry.key,
                    itemCount: entry.items.length,
                };
            }),
            [
                {
                    kind: TimelineEntryKind.UserMessage,
                    key: 'ask',
                    itemCount: 1,
                },
                {
                    kind: TimelineEntryKind.Work,
                    key: 'think',
                    itemCount: 2,
                },
                {
                    kind: TimelineEntryKind.AssistantMessage,
                    key: 'answer',
                    itemCount: 1,
                },
                {
                    kind: TimelineEntryKind.Work,
                    key: 'edit',
                    itemCount: 1,
                },
            ],
        );
    });
});

describe(summarizeWork.name, () => {
    it('names two kinds of work and counts the rest', () => {
        assert.strictEquals(
            summarizeWork([
                createItem({
                    kind: ThreadItemKind.Command,
                }),
                createItem({
                    kind: ThreadItemKind.FileChange,
                }),
                createItem({
                    kind: ThreadItemKind.Command,
                }),
                createItem({
                    kind: ThreadItemKind.Reasoning,
                }),
            ]),
            'Ran 2 commands, Changed 1 file +1 more',
        );
    });
    it('counts repeated reasoning', () => {
        assert.strictEquals(
            summarizeWork([
                createItem({
                    kind: ThreadItemKind.Reasoning,
                }),
                createItem({
                    kind: ThreadItemKind.Reasoning,
                }),
            ]),
            'Thought ×2',
        );
    });
});
