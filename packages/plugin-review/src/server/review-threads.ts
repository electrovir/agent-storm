import {PaneStatus, type ThreadOrigin, ThreadStatus} from '@agent-storm/common';
import {readReviewBuildV2} from './review-host.js';

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
        await readReviewBuildV2()
    ).findPluginThread({
        cwd: folder,
        origin,
    });
    return thread ? threadPaneStatuses[thread.status] : PaneStatus.None;
}
