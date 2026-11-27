import {PaneStatus, type ThreadOrigin, ThreadStatus} from '@agent-storm/common';
import {readReviewBuild} from './review-host.js';

/** A review thread's status as the pane status the review queue and the busy checks read. */
const threadPaneStatuses: Readonly<Record<ThreadStatus, PaneStatus>> = {
    [ThreadStatus.Idle]: PaneStatus.Idle,
    [ThreadStatus.Running]: PaneStatus.Busy,
    [ThreadStatus.NeedsApproval]: PaneStatus.Stalled,
    [ThreadStatus.Failed]: PaneStatus.Exited,
};

/** The status of `folder`'s newest `origin` thread, `PaneStatus.None` when it has none. */
export async function readReviewThreadStatus({
    folder,
    origin,
}: Readonly<{
    folder: string;
    origin: ThreadOrigin;
}>) {
    const thread = await (
        await readReviewBuild()
    ).findPluginThread({
        cwd: folder,
        origin,
    });
    return thread ? threadPaneStatuses[thread.status] : PaneStatus.None;
}

/**
 * Same as {@link readReviewThreadStatus} for every one of `folders` with one database query.
 * Resolves to a lookup by folder, which answers `PaneStatus.None` for a folder not in `folders`.
 */
export async function readReviewThreadStatusLookup({
    folders,
    origin,
}: Readonly<{
    folders: ReadonlyArray<string>;
    origin: ThreadOrigin;
}>) {
    const threads = await (
        await readReviewBuild()
    ).findPluginThreads({
        folders,
        origin,
    });
    const statusesByFolder = new Map<string, PaneStatus>();
    folders.forEach((folder, index) => {
        if (!statusesByFolder.has(folder)) {
            const thread = threads[index];
            statusesByFolder.set(
                folder,
                thread ? threadPaneStatuses[thread.status] : PaneStatus.None,
            );
        }
    });
    return (folder: string) => statusesByFolder.get(folder) || PaneStatus.None;
}
