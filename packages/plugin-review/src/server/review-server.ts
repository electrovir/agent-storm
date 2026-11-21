import {buildV2ExportsKey, ManualReviewStatus, ThreadOrigin} from '@agent-storm/common';
import {definePluginServer} from '@agent-storm/core/server';
import {check} from '@augment-vir/assert';
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
import {listenToManualReviewState, readManualReviewState} from './manual-review-state.js';
import {startReviewAutoStart} from './review-auto-start.js';
import {
    addReviewComment,
    deleteReviewComment,
    readReviewComments,
    updateReviewComment,
} from './review-comments.js';
import {readReviewExplanations} from './review-explanations.js';
import {findManualReviewCopy, sweepDeletingReviewFolders} from './review-folders.js';
import {readReviewBuildV2, setReviewBuildV2, setReviewHost} from './review-host.js';
import {getWatchModeInfo, setWatchMode, startWatchMode} from './watch-mode.js';

const ok = {
    ok: true,
} as const;

export default definePluginServer({
    api: reviewApi,
    async start({host, waitForPlugin}) {
        setReviewHost(host);
        setReviewBuildV2(async () => await waitForPlugin(buildV2ExportsKey));

        async function sendToReviewThread({
            folder,
            prompt,
            prUrl,
        }: Readonly<{
            folder: string;
            prompt: string;
            prUrl: string;
        }>) {
            return await (
                await readReviewBuildV2()
            ).sendToPluginThread({
                cwd: normalizePath(folder),
                origin: ThreadOrigin.Review,
                prUrl,
                text: prompt,
            });
        }

        void sweepDeletingReviewFolders();
        const stops = [
            startFolderPrCacheReset(),
            startPostedVerdictWatch(),
            await startWatchMode(host),
            listenToManualReviewState(async (changedEntries) => {
                /** The Approve and Request Changes buttons hold their status until the post lands. */
                await Promise.all(
                    changedEntries
                        .filter(({entry}) => entry.status === ManualReviewStatus.PostFailed)
                        .map(({entry}) => {
                            return host.holdPrStatus({
                                url: entry.prUrl || '',
                                status: undefined,
                            });
                        }),
                );
            }),
            /**
             * A named instance is a debug copy using the user's own GitHub login, which shouldn't
             * start reviews of the user's real PRs.
             */
            ...(instanceName
                ? []
                : [
                      startReviewAutoStart({
                          sendToReviewThread,
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
                async holdPrStatus({url, status}) {
                    await host.holdPrStatus({
                        url,
                        status: status || undefined,
                    });
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
                async sendToReviewThread(request) {
                    return {
                        threadId: (await sendToReviewThread(request)).id,
                    };
                },
                async readReviewThreads({folder}) {
                    const threads = await Promise.all(
                        [
                            ThreadOrigin.Review,
                            ThreadOrigin.Watch,
                        ].map(async (origin) => {
                            return await (
                                await readReviewBuildV2()
                            ).findPluginThread({
                                cwd: normalizePath(folder),
                                origin,
                            });
                        }),
                    );
                    return {
                        threads: threads.filter(check.isDefined).map((thread) => {
                            return {
                                threadId: thread.id,
                                origin: thread.origin,
                            };
                        }),
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
                setReviewBuildV2(undefined);
            },
        };
    },
});
