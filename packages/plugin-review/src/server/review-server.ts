import {definePluginServer} from '@agent-storm/core/server';
import {instanceName, normalizePath} from 'agent-storm-util';
import {reviewApi} from '../review-api.js';
import {
    editThreadComment,
    fetchFolderPr,
    postComment,
    setReaction,
    setThreadResolved,
    startFolderPrCacheReset,
} from './github-pr.js';
import {
    applyManualReviewStatus,
    closeReviewWindow,
    readAssigneeQueue,
    readReviewPr,
    readReviewQueue,
    refreshAssigneeQueue,
    refreshReviewQueue,
    resolveReviewFolder,
    runReviewInitCmd,
    startPostedVerdictWatch,
    stopPrQueues,
} from './github-review-queue.js';
import {readManualReviewState} from './manual-review-state.js';
import {startReviewAutoStart} from './review-auto-start.js';
import {
    addReviewComment,
    deleteReviewComment,
    readReviewComments,
    updateReviewComment,
} from './review-comments.js';
import {readReviewExplanations} from './review-explanations.js';
import {findManualReviewCopy, sweepDeletingReviewFolders} from './review-folders.js';
import {setReviewHost} from './review-host.js';
import {getWatchModeInfo, setWatchMode, startWatchMode} from './watch-mode.js';

const ok = {
    ok: true,
} as const;

export default definePluginServer({
    api: reviewApi,
    async start({host}) {
        setReviewHost(host);
        void sweepDeletingReviewFolders();
        const stops = [
            startFolderPrCacheReset(),
            startPostedVerdictWatch(),
            await startWatchMode(host),
            /**
             * A named instance is a debug copy using the user's own GitHub login, which shouldn't
             * start reviews of the user's real PRs.
             */
            ...(instanceName
                ? []
                : [
                      startReviewAutoStart({
                          launchFolderSession: host.launchFolderSession,
                          runReviewInitCmd,
                      }),
                  ]),
        ];
        return {
            calls: {
                async setWatchMode(request) {
                    await setWatchMode(request);
                    return ok;
                },
                async closeEditorWindow(request) {
                    await closeReviewWindow(request);
                    return ok;
                },
                async readReviewExplanations({folder}) {
                    return {
                        fileExplanations: await readReviewExplanations(folder),
                    };
                },
                async readReviewComments({folder}) {
                    return {
                        comments: await readReviewComments({
                            folder,
                        }),
                    };
                },
                async addReviewComment(request) {
                    return {
                        comments: await addReviewComment(request),
                    };
                },
                async updateReviewComment(request) {
                    return {
                        comments: await updateReviewComment(request),
                    };
                },
                async deleteReviewComment(request) {
                    return {
                        comments: await deleteReviewComment(request),
                    };
                },
                async readFolderPr({folder, forceRefresh}) {
                    return {
                        pr: await fetchFolderPr({
                            folder: normalizePath(folder),
                            forceRefresh,
                        }),
                    };
                },
                async readReviewQueue({forceRefresh}) {
                    return forceRefresh ? await refreshReviewQueue() : await readReviewQueue();
                },
                async readAssigneeQueue({forceRefresh}) {
                    return forceRefresh ? await refreshAssigneeQueue() : await readAssigneeQueue();
                },
                async resolveReviewFolder(request) {
                    return await resolveReviewFolder(request);
                },
                async runReviewInit(request) {
                    await runReviewInitCmd(request);
                    return ok;
                },
                async readReviewPr(request) {
                    return await readReviewPr(request);
                },
                async findManualReviewCopy({folder}) {
                    return {
                        folder: await findManualReviewCopy(normalizePath(folder)),
                    };
                },
                async readManualReviewState(request) {
                    return {
                        review: await readManualReviewState(request),
                    };
                },
                async postGitHubComment(request) {
                    await postComment(request);
                    return ok;
                },
                async editGitHubThreadComment(request) {
                    await editThreadComment(request);
                    return ok;
                },
                async setGitHubReaction(request) {
                    await setReaction(request);
                    return ok;
                },
                async setGitHubThreadResolved(request) {
                    await setThreadResolved(request);
                    return ok;
                },
            },
            folderHooks: {
                overridePrStatus: applyManualReviewStatus,
                readWatchMode: getWatchModeInfo,
            },
            stop() {
                stops.forEach((stop) => stop());
                stopPrQueues();
                setReviewHost(undefined);
            },
        };
    },
});
