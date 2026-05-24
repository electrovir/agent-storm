import {PathTree, SpaRouter, type FullSpaRoute} from 'spa-router-vir';

/**
 * The valid shape of the in-app URL.
 *
 * - `/` — default experience, nothing selected.
 * - `/<repoName>` — a standalone (non-worktree) repo selected. If the segment matches a repo that
 *   _has_ worktrees, the route is invalid; `vir-app` redirects back to `/` once it has folder info
 *   to make that determination.
 * - `/<repoName>/<worktreeName>` — a worktree under a worktree-root repo selected.
 * - `/book/<...>` — the element-book route (preserved from the previous router so deep links keep
 *   working).
 *
 * The `:repo-name` / `:worktree-name` segments are dynamic — sanitization keeps whatever value the
 * user typed and lets `vir-app` resolve it against the live folder list.
 */
export const frontendPathTree = new PathTree({
    allowBare: true,
    children: {
        ':repo-name': {
            allowBare: true,
            children: {
                ':worktree-name': {},
            },
        },
        book: {
            anyChildren: true,
        },
    },
});

export type FrontendPaths = typeof frontendPathTree.PathsType;
export type AppRoute = Readonly<FullSpaRoute<FrontendPaths, undefined, undefined>>;

export const router = new SpaRouter<FrontendPaths, undefined, undefined>({
    sanitizeRoute(rawRoute) {
        return {
            paths: frontendPathTree.sanitizePaths(rawRoute.paths),
            search: undefined,
            hash: undefined,
        };
    },
});
