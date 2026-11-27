import {toReviewPrPaths} from '@agent-storm/common';
import {type PluginServerHost} from '@agent-storm/core/server';
import {extractErrorMessage, log} from '@augment-vir/common';
import {ReviewNotificationName, reviewNotificationTypes} from '../notification-types.js';
import {listenToReviewQueue} from './github-review-queue.js';

async function readRepoFolders(
    host: Readonly<Pick<PluginServerHost, 'listFolders' | 'getRepoSlug'>>,
) {
    const repoFolders = (await host.listFolders()).filter((folder) => !folder.parentRepoPath);
    return await Promise.all(
        repoFolders.map(async ({path}) => {
            return {
                path,
                slug: await host.getRepoSlug(path),
            };
        }),
    );
}

/**
 * Notifies of each PR that joins the Reviewer list. The list's first update after start only sets
 * what counts as already seen.
 */
export function startReviewNotifications(host: Readonly<PluginServerHost>) {
    const notifierState: {
        seenUrls: ReadonlyArray<string> | undefined;
    } = {
        seenUrls: undefined,
    };
    return listenToReviewQueue(async (pullRequests) => {
        const requests = pullRequests.filter((pr) => {
            return pr.isAwaitingViewerReview && !pr.isViewerAuthor && !pr.isDraft;
        });
        const seenUrls = notifierState.seenUrls;
        const latestUrls = requests.map((pr) => pr.url);
        if (!seenUrls) {
            notifierState.seenUrls = latestUrls;
            return;
        }
        const newRequests = requests.filter((pr) => !seenUrls.includes(pr.url));
        if (!newRequests.length) {
            notifierState.seenUrls = latestUrls;
            return;
        }
        const repoFolders = await readRepoFolders(host).catch((error: unknown) => {
            log.warning(
                `Could not read folders for review notifications. ${extractErrorMessage(error)}`,
            );
            return undefined;
        });
        notifierState.seenUrls = repoFolders
            ? latestUrls
            : latestUrls.filter((url) => seenUrls.includes(url));
        if (!repoFolders) {
            return;
        }
        await Promise.all(
            newRequests.map(async (pr) => {
                try {
                    await host.notify({
                        type: reviewNotificationTypes[ReviewNotificationName.NewReviewRequest],
                        title: pr.title,
                        body: [
                            `${pr.owner}/${pr.repoName}#${pr.number}`,
                            pr.author ? `by ${pr.author}` : '',
                        ]
                            .filter(Boolean)
                            .join(' '),
                        paths: toReviewPrPaths({
                            owner: pr.owner,
                            repoName: pr.repoName,
                            number: String(pr.number),
                        }),
                        folder: repoFolders.find(({slug}) => {
                            return slug?.owner === pr.owner && slug.name === pr.repoName;
                        })?.path,
                    });
                } catch (error) {
                    log.warning(
                        `Notifying of review request ${pr.url} failed: ${extractErrorMessage(error)}`,
                    );
                }
            }),
        );
    });
}
