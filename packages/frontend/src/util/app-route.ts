import {type FolderInfo, type ReviewQueuePr} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {type FolderDataObservable} from './folder-data.js';
import {pullRequestRouteKey} from './frontend-state.js';
import {
    ActivityId,
    activityIdFromRoute,
    bareActivityPaths,
    router,
    type AppRoute,
    type AppRouteUpdate,
    type FrontendPaths,
} from './router.js';

type PullRequestRef = Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number'>;

/**
 * The folder a Build route's segments (after the main-tab segment) select, or `isInvalid` when the
 * URL can't be valid given the current folder list (e.g. `/build/<repoName>` where that repo has
 * worktrees, or `/build/<repoName>/<worktreeName>` where neither exists).
 */
function resolveBuildFolder(
    routePaths: ReadonlyArray<string>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
) {
    /**
     * Bail before folder info has loaded so we don't redirect a URL that might be perfectly valid
     * once data arrives.
     */
    if (routePaths.length === 0 || folderInfo.size === 0) {
        return {
            folder: undefined,
            isInvalid: false,
        };
    }
    const [
        repoName,
        worktreeName,
    ] = routePaths;
    const folders = Array.from(folderInfo.values());
    if (!worktreeName) {
        /**
         * Single-segment URL: only valid if it matches a standalone (non-worktree-root, no-parent)
         * repo. Worktree-root matches are explicitly invalid per the route spec — the user must
         * pick a worktree segment.
         */
        const standalone = folders.find((folder) => {
            return folder.name === repoName && !folder.isWorktreeRoot && !folder.parentRepoPath;
        });
        return {
            folder: standalone,
            isInvalid: !standalone,
        };
    }
    const repoRoot = folders.find((folder) => folder.name === repoName && folder.isWorktreeRoot);
    const worktree =
        repoRoot &&
        folders.find(
            (folder) => folder.parentRepoPath === repoRoot.path && folder.name === worktreeName,
        );
    return {
        folder: worktree,
        isInvalid: !worktree,
    };
}

/**
 * Compute the URL paths that should represent the given folder, always under the Build tab.
 *
 * - Standalone repo → `[build, folder.name]`.
 * - Worktree child → `[build, parentRepoName, folder.name]` (we resolve the parent's name through
 *   `folderInfo`; falls back to its basename via `parentRepoPath` if for some reason the parent
 *   isn't in the map).
 * - Worktree root → `[build, folder.name]` (the activation path for worktree-roots is "user clicked a
 *   child", so this branch is mostly defensive; if it ever fires the redirect-to-root logic above
 *   will undo it on the next render).
 */
function pathsForFolder(
    folder: Readonly<FolderInfo>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): FrontendPaths {
    if (folder.parentRepoPath) {
        const parent = folderInfo.get(folder.parentRepoPath);
        const parentName = parent?.name || folder.parentRepoPath.split('/').findLast(Boolean);
        return [
            ActivityId.Build,
            parentName || folder.parentRepoPath,
            folder.name,
        ];
    }
    return [
        ActivityId.Build,
        folder.name,
    ];
}

/** The route for selecting `folder`. */
export function routeForFolder(
    folder: Readonly<FolderInfo>,
    folderInfo: ReadonlyMap<string, FolderInfo>,
): AppRouteUpdate {
    return {
        paths: pathsForFolder(folder, folderInfo),
    };
}

/** The route for selecting a pull request. */
export function routeForPullRequest(pullRequest: Readonly<PullRequestRef>): AppRouteUpdate {
    return {
        paths: [
            ActivityId.Review,
            pullRequest.owner,
            pullRequest.repoName,
            String(pullRequest.number),
        ],
    };
}

/**
 * Routes to the folder an AI asks to switch to. Only the visible tab follows, so a background tab
 * doesn't change under the user, and only once per request, so the user can switch away. Returns
 * the listener's remover.
 */
export function followFolderActivations(
    folderData: Readonly<Pick<FolderDataObservable, 'listen'>>,
): () => void {
    const followed: {
        requestId: string | undefined;
    } = {
        requestId: undefined,
    };
    return folderData.listen(true, ({live, folderInfo}) => {
        const folderActivation = live?.listing.folderActivation;
        const folder = folderActivation && folderInfo.get(folderActivation.folder);
        if (
            folderActivation &&
            folder &&
            folderActivation.requestId !== followed.requestId &&
            document.visibilityState === 'visible'
        ) {
            followed.requestId = folderActivation.requestId;
            router.setRoute(routeForFolder(folder, folderInfo));
        }
    });
}

/**
 * Everything the app derives from the URL and the live data: which tab, folder, and pull request it
 * selects, where each main tab goes when opened with nothing selected, and the route to switch to
 * when the URL is invalid or names nothing (`redirect`).
 *
 * `reviewablePrs` is undefined until the review queue loads, and while it is no pull request can be
 * selected.
 */
export function resolveAppRoute({
    route,
    folderInfo,
    enabledActivityIds,
    reviewablePrs,
    rememberedFolderPath,
    rememberedPullRequestKey,
}: Readonly<{
    route: AppRoute;
    folderInfo: ReadonlyMap<string, FolderInfo>;
    /**
     * In strip order. Undefined until the UI layout loads, and while it is no activity redirects
     * for being off.
     */
    enabledActivityIds: ReadonlyArray<ActivityId> | undefined;
    reviewablePrs: ReadonlyArray<Readonly<PullRequestRef>> | undefined;
    rememberedFolderPath: string | undefined;
    rememberedPullRequestKey: string | undefined;
}>) {
    const activityId = activityIdFromRoute(route);
    const buildFolder =
        activityId === ActivityId.Build
            ? resolveBuildFolder(route.paths.slice(1), folderInfo)
            : {
                  folder: undefined,
                  isInvalid: false,
              };
    const reviewQueueKeys = reviewablePrs?.map((pr) => pullRequestRouteKey(pr));
    const routedPullRequest =
        activityId === ActivityId.Review && check.isLengthExactly(route.paths, 4)
            ? route.paths.slice(1).join('/')
            : undefined;
    /**
     * A PR that has left the review queue can't be selected, even from its URL. The cached queue
     * isn't enough to allow one: opening a PR that has since left would respawn its AI pane.
     */
    const activePullRequest =
        routedPullRequest && reviewQueueKeys?.includes(routedPullRequest)
            ? routedPullRequest
            : undefined;
    const rememberedFolder = folderInfo.get(rememberedFolderPath || '');
    const rememberedPullRequest = reviewablePrs?.find((pr) => {
        return pullRequestRouteKey(pr) === rememberedPullRequestKey;
    });
    const restoredRouteByActivity: Readonly<Record<ActivityId, AppRouteUpdate | undefined>> = {
        [ActivityId.Dashboard]: undefined,
        [ActivityId.Build]: rememberedFolder && routeForFolder(rememberedFolder, folderInfo),
        [ActivityId.Review]: rememberedPullRequest && routeForPullRequest(rememberedPullRequest),
        [ActivityId.Debug]: undefined,
    };
    const restoredRoute =
        route.paths.length === 1 ? restoredRouteByActivity[activityId] : undefined;

    const enabledFallback =
        enabledActivityIds && !enabledActivityIds.includes(activityId)
            ? enabledActivityIds[0]
            : undefined;

    const redirect = enabledFallback
        ? {
              route: {
                  paths: bareActivityPaths[enabledFallback],
              },
              replace: true,
          }
        : buildFolder.isInvalid
          ? {
                route: {
                    paths: bareActivityPaths[ActivityId.Build],
                },
                replace: false,
            }
          : restoredRoute && {
                route: restoredRoute,
                replace: true,
            };

    return {
        activityId,
        activeFolder: buildFolder.folder,
        activePullRequest,
        reviewQueueKeys,
        restoredRouteByActivity,
        redirect,
    };
}
