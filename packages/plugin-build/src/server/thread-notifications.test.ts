import {type NotifyParams, PrStatus} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ThreadOrigin, ThreadStatus} from '../build-api.js';
import {BuildNotificationName, buildNotificationTypes} from '../notification-types.js';
import {
    createThreadNotifier,
    findThreadNotification,
    type NotifierFolder,
    type NotifierThread,
} from './thread-notifications.js';

const userThread: NotifierThread = {
    id: 'thread-1',
    cwd: '/repos/app-feature',
    title: 'Fix the build',
    status: ThreadStatus.Idle,
    isPriority: false,
    isAskingQuestion: false,
    backgroundTaskCount: 0,
    origin: ThreadOrigin.User,
    prUrl: null,
    parentThreadId: null,
};

const runningThread: NotifierThread = {
    ...userThread,
    status: ThreadStatus.Running,
};

const reviewFolder: NotifierFolder = {
    path: userThread.cwd,
    prUrl: 'https://github.com/example/app/pull/12',
    prStatus: PrStatus.ReviewStarted,
};

function findTypeId(params: Readonly<{previous: NotifierThread; thread: NotifierThread}>) {
    return findThreadNotification({
        ...params,
        threads: [],
    })?.type.id;
}

describe(findThreadNotification.name, () => {
    it('picks the finish type by priority and skips a thread whose background tasks still work', () => {
        assert.deepEquals(
            [
                findTypeId({
                    previous: runningThread,
                    thread: userThread,
                }),
                findTypeId({
                    previous: runningThread,
                    thread: {
                        ...userThread,
                        isPriority: true,
                    },
                }),
                findTypeId({
                    previous: runningThread,
                    thread: {
                        ...userThread,
                        backgroundTaskCount: 1,
                    },
                }),
            ],
            [
                buildNotificationTypes[BuildNotificationName.ThreadFinished].id,
                buildNotificationTypes[BuildNotificationName.PriorityThreadFinished].id,
                undefined,
            ],
        );
    });

    it('asks for attention once per status and routes a review thread to its PR', () => {
        const reviewThread: NotifierThread = {
            ...runningThread,
            origin: ThreadOrigin.Review,
            prUrl: 'https://github.com/example/app/pull/12',
        };
        const questionThread: NotifierThread = {
            ...reviewThread,
            status: ThreadStatus.NeedsApproval,
            isAskingQuestion: true,
        };
        assert.deepEquals(
            [
                findThreadNotification({
                    previous: reviewThread,
                    thread: questionThread,
                    threads: [],
                }),
                findThreadNotification({
                    previous: questionThread,
                    thread: questionThread,
                    threads: [],
                }),
            ],
            [
                {
                    type: buildNotificationTypes[BuildNotificationName.NeedsAttention],
                    title: 'Fix the build',
                    body: 'Asked you a question.',
                    paths: [
                        'review',
                        'example',
                        'app',
                        '12',
                    ],
                    folder: userThread.cwd,
                },
                undefined,
            ],
        );
    });
});

describe(createThreadNotifier.name, () => {
    it('holds a finish until after-turn work ends, and drops it if the thread runs again', () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        notifier.seed({
            threads: [
                runningThread,
            ],
            folders: [],
        });
        notifier.holdFinish(userThread.id);
        notifier.observeThread(userThread);
        notifier.observeThread(runningThread);
        notifier.releaseFinish(userThread.id);
        const afterContinuation = sent.length;
        notifier.holdFinish(userThread.id);
        notifier.observeThread(userThread);
        const whileHeld = sent.length;
        notifier.releaseFinish(userThread.id);
        assert.deepEquals(
            [
                afterContinuation,
                whileHeld,
                sent.map((params) => params.type.id),
            ],
            [
                0,
                0,
                [
                    buildNotificationTypes[BuildNotificationName.ThreadFinished].id,
                ],
            ],
        );
    });

    it("waits for the folder's AI Watch tab to stop before notifying a finish", () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        const watchThread: NotifierThread = {
            ...userThread,
            id: 'thread-2',
            origin: ThreadOrigin.Watch,
        };
        const runningWatchThread: NotifierThread = {
            ...watchThread,
            status: ThreadStatus.Running,
        };
        notifier.seed({
            threads: [
                runningThread,
                runningWatchThread,
            ],
            folders: [],
        });
        notifier.observeThread(userThread);
        const whileWatchWorks = sent.length;
        notifier.observeThread(watchThread);
        const afterWatchStops = sent.length;

        notifier.observeThread(runningWatchThread);
        notifier.observeThread(runningThread);
        notifier.observeThread(userThread);
        notifier.observeThread(runningThread);
        notifier.observeThread(watchThread);
        const afterThreadRanAgain = sent.length;
        notifier.observeThread(userThread);
        assert.deepEquals(
            {
                whileWatchWorks,
                afterWatchStops,
                afterThreadRanAgain,
                types: sent.map((params) => params.type.id),
            },
            {
                whileWatchWorks: 0,
                afterWatchStops: 1,
                afterThreadRanAgain: 1,
                types: [
                    buildNotificationTypes[BuildNotificationName.ThreadFinished].id,
                    buildNotificationTypes[BuildNotificationName.ThreadFinished].id,
                ],
            },
        );
    });

    it('waits for after-turn work before notifying that a worktree is ready for review', () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        const watchThread: NotifierThread = {
            ...runningThread,
            id: 'thread-2',
            origin: ThreadOrigin.Watch,
        };
        notifier.seed({
            threads: [
                userThread,
                watchThread,
            ],
            folders: [
                reviewFolder,
            ],
        });
        notifier.holdFinish(watchThread.id);
        notifier.observeThread({
            ...watchThread,
            status: ThreadStatus.Idle,
        });
        const whileHeld = sent.length;

        notifier.releaseFinish(watchThread.id);
        assert.deepEquals(
            {
                whileHeld,
                types: sent.map((params) => params.type.id),
            },
            {
                whileHeld: 0,
                types: [
                    buildNotificationTypes[BuildNotificationName.WorktreeNeedsReview].id,
                ],
            },
        );
    });

    it('waits for a thread to finish after asking for approval before notifying review readiness', () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        notifier.seed({
            threads: [
                runningThread,
            ],
            folders: [
                reviewFolder,
            ],
        });
        notifier.observeThread({
            ...runningThread,
            status: ThreadStatus.NeedsApproval,
        });
        const whileWaiting = sent.map((params) => params.type.id);
        notifier.observeThread(userThread);

        assert.deepEquals(
            {
                whileWaiting,
                allTypes: sent.map((params) => params.type.id),
            },
            {
                whileWaiting: [
                    buildNotificationTypes[BuildNotificationName.NeedsAttention].id,
                ],
                allTypes: [
                    buildNotificationTypes[BuildNotificationName.NeedsAttention].id,
                    buildNotificationTypes[BuildNotificationName.WorktreeNeedsReview].id,
                ],
            },
        );
    });

    it('stays silent for the seeded review, even after its threads work again', () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        notifier.seed({
            threads: [
                userThread,
            ],
            folders: [
                reviewFolder,
            ],
        });
        notifier.observeThread(runningThread);
        notifier.observeThread(userThread);
        notifier.observeFolder(reviewFolder);
        assert.deepEquals(
            sent.map((params) => params.type.id),
            [
                buildNotificationTypes[BuildNotificationName.ThreadFinished].id,
            ],
        );
    });

    it('notifies a review once its threads stop working, and again only after the review ends', () => {
        const sent: NotifyParams[] = [];
        const notifier = createThreadNotifier((params) => sent.push(params));
        const watchThread: NotifierThread = {
            ...userThread,
            id: 'thread-2',
            origin: ThreadOrigin.Watch,
        };
        const runningWatchThread: NotifierThread = {
            ...watchThread,
            status: ThreadStatus.Running,
        };
        notifier.seed({
            threads: [
                userThread,
                runningWatchThread,
            ],
            folders: [],
        });
        notifier.observeFolder(reviewFolder);
        const whileWorking = sent.length;
        notifier.observeThread(watchThread);
        notifier.observeFolder({
            ...reviewFolder,
            prStatus: PrStatus.ChecksFailed,
        });
        notifier.observeFolder(reviewFolder);
        notifier.observeFolder({
            ...reviewFolder,
            prStatus: PrStatus.None,
            prUrl: null,
        });
        notifier.observeFolder(reviewFolder);
        notifier.observeThread(runningWatchThread);
        notifier.observeThread(watchThread);
        const beforeReviewEnds = sent.length;
        notifier.observeFolder({
            ...reviewFolder,
            prStatus: PrStatus.ChangesRequested,
        });
        notifier.observeFolder({
            ...reviewFolder,
            prStatus: PrStatus.ReReviewRequested,
        });
        const whileSettingUp = sent.length;
        notifier.observeFolder(reviewFolder);
        assert.deepEquals(
            [
                whileWorking,
                beforeReviewEnds,
                whileSettingUp,
                sent.map((params) => {
                    return [
                        params.type.id,
                        params.title,
                    ];
                }),
            ],
            [
                0,
                1,
                1,
                [
                    [
                        buildNotificationTypes[BuildNotificationName.WorktreeNeedsReview].id,
                        userThread.title,
                    ],
                    [
                        buildNotificationTypes[BuildNotificationName.WorktreeNeedsReview].id,
                        userThread.title,
                    ],
                ],
            ],
        );
    });
});
