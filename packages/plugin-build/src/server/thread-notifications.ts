import {
    botsPluginId,
    type FolderInfo,
    type NotifyParams,
    PrStatus,
    sidebarThreadOrigins,
    toReviewPrPaths,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    buildPluginId,
    busyThreadStatuses,
    type Thread,
    ThreadOrigin,
    ThreadStatus,
} from '../build-api.js';
import {BuildNotificationName, buildNotificationTypes} from '../notification-types.js';
import {isThreadWorking} from '../util/thread-activity.js';

/** The parts of a thread its notifications depend on. */
export type NotifierThread = Readonly<
    Pick<
        Thread,
        | 'id'
        | 'cwd'
        | 'title'
        | 'status'
        | 'isPriority'
        | 'isAskingQuestion'
        | 'backgroundTaskCount'
        | 'origin'
        | 'prUrl'
        | 'parentThreadId'
    >
>;

/** The parts of a folder its review notification depends on. */
export type NotifierFolder = Readonly<Pick<FolderInfo, 'path' | 'prUrl' | 'prStatus'>>;

/** What a thread entering each status says, for the statuses that need the user. */
const attentionBodies: Readonly<
    Record<ThreadStatus, ((thread: NotifierThread) => string) | undefined>
> = {
    [ThreadStatus.Idle]: undefined,
    [ThreadStatus.Running]: undefined,
    [ThreadStatus.NeedsApproval](thread) {
        return thread.isAskingQuestion ? 'Asked you a question.' : 'Waits on your approval.';
    },
    [ThreadStatus.Failed]() {
        return 'Failed.';
    },
};

/**
 * Whether a thread of each origin notifies when it finishes. Review and Watch threads are other
 * plugins' background work.
 */
const notifiesOnFinish: Readonly<Record<ThreadOrigin, boolean>> = {
    [ThreadOrigin.User]: true,
    [ThreadOrigin.SideChat]: true,
    [ThreadOrigin.PaneChat]: true,
    [ThreadOrigin.Review]: false,
    [ThreadOrigin.Watch]: false,
    [ThreadOrigin.SelfImprove]: false,
    /** The Bots plugin reports on its bots' runs instead. */
    [ThreadOrigin.Bot]: false,
};

/** PR statuses after which the PR waiting on the viewer's review again is a new review. */
const endsViewerReview: Readonly<Record<PrStatus, boolean>> = {
    [PrStatus.None]: false,
    [PrStatus.AwaitingReview]: false,
    [PrStatus.ReviewStarted]: false,
    [PrStatus.ReReviewRequested]: false,
    [PrStatus.UnresolvedComments]: false,
    [PrStatus.ChangesRequested]: true,
    [PrStatus.Approved]: true,
    [PrStatus.OthersRequestedChanges]: false,
    [PrStatus.AwaitingOtherReviews]: false,
    [PrStatus.ChecksFailed]: false,
    [PrStatus.ReadyToMerge]: false,
    [PrStatus.Merged]: true,
    [PrStatus.Closed]: true,
};

/** The Review activity's route for the PR at `prUrl`, if it is a GitHub-style PR URL. */
function findReviewPaths(prUrl: string | null | undefined) {
    const segments = prUrl ? URL.parse(prUrl)?.pathname.split('/').filter(Boolean) : undefined;
    if (!segments || !check.isLengthExactly(segments, 4)) {
        return undefined;
    }
    const [
        owner,
        repoName,
        pullSegment,
        number,
    ] = segments;
    return pullSegment === 'pull' && /^\d+$/.test(number)
        ? toReviewPrPaths({
              owner,
              repoName,
              number,
          })
        : undefined;
}

function findOwnThreadPaths({thread}: Readonly<{thread: NotifierThread}>) {
    return [
        buildPluginId,
        thread.id,
    ];
}

function findPrThreadPaths({thread}: Readonly<{thread: NotifierThread}>) {
    return (
        findReviewPaths(thread.prUrl) || [
            buildPluginId,
        ]
    );
}

/** The route that shows each origin's thread. */
const threadPathFinders: Readonly<
    Record<
        ThreadOrigin,
        (
            params: Readonly<{
                thread: NotifierThread;
                threads: Iterable<NotifierThread>;
            }>,
        ) => string[]
    >
> = {
    [ThreadOrigin.User]: findOwnThreadPaths,
    [ThreadOrigin.SelfImprove]: findOwnThreadPaths,
    [ThreadOrigin.Bot]() {
        return [
            botsPluginId,
        ];
    },
    [ThreadOrigin.SideChat]({thread}) {
        return thread.parentThreadId
            ? [
                  buildPluginId,
                  thread.parentThreadId,
              ]
            : [
                  buildPluginId,
              ];
    },
    [ThreadOrigin.PaneChat]({thread, threads}) {
        const owner = [
            ...threads,
        ].find((candidate) => {
            return candidate.origin === ThreadOrigin.User && candidate.cwd === thread.cwd;
        });
        return owner
            ? [
                  buildPluginId,
                  owner.id,
              ]
            : [
                  buildPluginId,
              ];
    },
    [ThreadOrigin.Review]: findPrThreadPaths,
    [ThreadOrigin.Watch]: findPrThreadPaths,
};

/**
 * The notification `thread` changing from `previous` calls for, if any. `previous` is undefined for
 * a thread not seen before. `threads` are every other known thread, to route pane chats to.
 */
export function findThreadNotification({
    previous,
    thread,
    threads,
}: Readonly<{
    previous: NotifierThread | undefined;
    thread: NotifierThread;
    threads: Iterable<NotifierThread>;
}>) {
    const attentionBody =
        previous?.status === thread.status ? undefined : attentionBodies[thread.status]?.(thread);
    const isFinished =
        !!previous &&
        notifiesOnFinish[thread.origin] &&
        thread.status === ThreadStatus.Idle &&
        isThreadWorking(previous) &&
        !isThreadWorking(thread);
    const type = attentionBody
        ? buildNotificationTypes[BuildNotificationName.NeedsAttention]
        : isFinished
          ? buildNotificationTypes[
                thread.isPriority
                    ? BuildNotificationName.PriorityThreadFinished
                    : BuildNotificationName.ThreadFinished
            ]
          : undefined;
    return type
        ? {
              type,
              title: thread.title || 'Untitled thread',
              body: attentionBody || 'Finished.',
              paths: threadPathFinders[thread.origin]({
                  thread,
                  threads,
              }),
              folder: thread.cwd,
          }
        : undefined;
}

/**
 * Tracks every thread and folder to notify on their changes. Nothing notifies until `seed` gives
 * the state the app started with, so restoring that state stays silent.
 */
export function createThreadNotifier(notify: (params: NotifyParams) => void) {
    const threads = new Map<string, NotifierThread>();
    const folders = new Map<string, NotifierFolder>();
    /**
     * The PR each folder already notified a review of, so a review notifies once. Its threads
     * working again or its status flickering between GitHub lookups doesn't end that review.
     */
    const notifiedReviewUrls = new Map<string, string>();
    /**
     * Threads whose finish waits on `releaseFinish`, each with how it looked while still working
     * once it has stopped.
     */
    const heldThreads = new Map<string, NotifierThread | undefined>();
    /**
     * Sidebar threads whose finish waits on other AI work their sidebar row still spins for, each
     * with how it looked while still working.
     */
    const waitingFinishes = new Map<string, NotifierThread>();
    const notifierState = {
        isSeeded: false,
    };

    /**
     * Whether the sidebar row of `thread` still spins for a side chat of it, or for an AI Review,
     * AI Watch, or pane AI Chat tab in its folder.
     */
    function hasWorkingCompanion(thread: NotifierThread) {
        return (
            sidebarThreadOrigins.includes(thread.origin) &&
            [
                ...threads.values(),
            ].some((other) => {
                return (
                    other.id !== thread.id &&
                    isThreadWorking(other) &&
                    (other.parentThreadId === thread.id ||
                        (other.cwd === thread.cwd &&
                            other.origin !== ThreadOrigin.SideChat &&
                            !sidebarThreadOrigins.includes(other.origin)))
                );
            })
        );
    }

    function sendFinish({
        workingThread,
        thread,
    }: Readonly<{workingThread: NotifierThread; thread: NotifierThread}>) {
        if (hasWorkingCompanion(thread)) {
            waitingFinishes.set(thread.id, workingThread);
            return;
        }
        const notification = findThreadNotification({
            previous: workingThread,
            thread,
            threads: threads.values(),
        });
        if (notification) {
            notify(notification);
        }
    }

    function sendWaitingFinishes() {
        waitingFinishes.forEach((workingThread, threadId) => {
            const thread = threads.get(threadId);
            if (thread && !hasWorkingCompanion(thread)) {
                waitingFinishes.delete(threadId);
                sendFinish({
                    workingThread,
                    thread,
                });
            }
        });
    }

    function checkFolder(path: string) {
        const folder = folders.get(path);
        const notifiedUrl = notifiedReviewUrls.get(path);
        if (
            folder &&
            notifiedUrl &&
            ((folder.prUrl && folder.prUrl !== notifiedUrl) || endsViewerReview[folder.prStatus])
        ) {
            notifiedReviewUrls.delete(path);
        }
        if (
            !folder?.prUrl ||
            folder.prStatus !== PrStatus.ReviewStarted ||
            notifiedReviewUrls.has(path)
        ) {
            return;
        }
        const folderThreads = [
            ...threads.values(),
        ].filter((thread) => thread.cwd === path);
        if (
            folderThreads.some((thread) => {
                return (
                    busyThreadStatuses[thread.status] ||
                    isThreadWorking(thread) ||
                    heldThreads.has(thread.id)
                );
            })
        ) {
            return;
        }
        const userThread = folderThreads.find((thread) => thread.origin === ThreadOrigin.User);
        if (userThread) {
            notifiedReviewUrls.set(path, folder.prUrl);
            if (notifierState.isSeeded) {
                notify({
                    type: buildNotificationTypes[BuildNotificationName.WorktreeNeedsReview],
                    title: userThread.title || 'Untitled thread',
                    body: 'Ready for your review.',
                    paths: [
                        buildPluginId,
                        userThread.id,
                    ],
                    folder: folder.path,
                });
            }
        }
    }

    return {
        seed({
            threads: seedThreads,
            folders: seedFolders,
        }: Readonly<{
            threads: ReadonlyArray<NotifierThread>;
            folders: ReadonlyArray<NotifierFolder>;
        }>) {
            seedThreads.forEach((thread) => threads.set(thread.id, thread));
            seedFolders.forEach((folder) => folders.set(folder.path, folder));
            folders.forEach((folder) => checkFolder(folder.path));
            notifierState.isSeeded = true;
        },
        observeThread(thread: NotifierThread) {
            const previous = threads.get(thread.id);
            threads.set(thread.id, thread);
            if (!notifierState.isSeeded) {
                return;
            }
            const notification = findThreadNotification({
                previous,
                thread,
                threads: threads.values(),
            });
            const isHeld = heldThreads.has(thread.id);
            if (isHeld && isThreadWorking(thread)) {
                heldThreads.set(thread.id, undefined);
            }
            if (thread.status !== ThreadStatus.Idle || isThreadWorking(thread)) {
                waitingFinishes.delete(thread.id);
            }
            const isFinish =
                !!notification &&
                notification.type !== buildNotificationTypes[BuildNotificationName.NeedsAttention];
            if (isHeld && isFinish) {
                heldThreads.set(thread.id, previous);
            } else if (isFinish && previous) {
                sendFinish({
                    workingThread: previous,
                    thread,
                });
            } else if (notification) {
                notify(notification);
            }
            sendWaitingFinishes();
            checkFolder(thread.cwd);
            if (previous && previous.cwd !== thread.cwd) {
                checkFolder(previous.cwd);
            }
        },
        /**
         * Holds the finish notification of a thread whose turn ending may not end its work, such as
         * one an after-turn action moves and sends a continuation, until `releaseFinish`.
         */
        holdFinish(threadId: string) {
            heldThreads.set(threadId, heldThreads.get(threadId));
        },
        /** Sends the finish `holdFinish` held, unless the thread has worked again since. */
        releaseFinish(threadId: string) {
            const workingThread = heldThreads.get(threadId);
            const wasHeld = heldThreads.delete(threadId);
            const thread = threads.get(threadId);
            if (workingThread && thread?.status === ThreadStatus.Idle) {
                sendFinish({
                    workingThread,
                    thread,
                });
            }
            if (wasHeld && thread) {
                checkFolder(thread.cwd);
            }
        },
        forgetThread(threadId: string) {
            const previous = threads.get(threadId);
            threads.delete(threadId);
            heldThreads.delete(threadId);
            waitingFinishes.delete(threadId);
            sendWaitingFinishes();
            if (previous) {
                checkFolder(previous.cwd);
            }
        },
        observeFolder(folder: NotifierFolder) {
            folders.set(folder.path, folder);
            checkFolder(folder.path);
        },
    };
}
