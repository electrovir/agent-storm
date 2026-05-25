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

/**
 * Search params allowed on the URL.
 *
 * - `code` — a value-less flag (`?code`). Only kept on repo-selection routes (`/<repoName>` or
 *   `/<repoName>/<worktreeName>`); stripped everywhere else. Unused for now, reserved for a future
 *   feature.
 *
 * Each value is a `ReadonlyArray<string>` because `URLSearchParams` lets a key repeat. We normalize
 * `code` to an _empty_ array — url-vir's `searchParamsToString` serializes a non-empty array as
 * `code=...` (with the `=`) and an empty array as just `code` (no `=`), so this is what makes the
 * URL canonical for a presence-only flag.
 */
export type FrontendSearchParams =
    | Readonly<{
          code?: ReadonlyArray<string>;
      }>
    | undefined;

export type AppRoute = Readonly<FullSpaRoute<FrontendPaths, FrontendSearchParams, undefined>>;

function isRepoSelectionRoute(paths: ReadonlyArray<string>): boolean {
    return paths.length >= 1 && paths[0] !== 'book';
}

function sanitizeSearch(
    paths: ReadonlyArray<string>,
    rawSearch: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): FrontendSearchParams {
    if (!rawSearch || !isRepoSelectionRoute(paths)) {
        return undefined;
        /**
         * Presence-only flag. `?code` parses to `code: []`, `?code=foo` to `code: ['foo']`. Either
         * way we collapse to an empty array — that's what url-vir's `searchParamsToString`
         * serializes as just `code` (no `=`), keeping the URL canonical regardless of what the user
         * typed (there is no value content to preserve).
         */
    } else if (rawSearch.code !== undefined) {
        return {
            code: [],
        };
    }
    return undefined;
}

export const router = new SpaRouter<FrontendPaths, FrontendSearchParams, undefined>({
    sanitizeRoute(rawRoute) {
        const paths = frontendPathTree.sanitizePaths(rawRoute.paths);
        return {
            paths,
            search: sanitizeSearch(paths, rawRoute.search),
            hash: undefined,
        };
    },
});
