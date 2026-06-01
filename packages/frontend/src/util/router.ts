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
 * Which pane the user is focused on. On desktop, `ai` and `shell` both render the "CLI" tab with
 * both panes visible side-by-side (their difference doesn't affect the layout); `code` shows the VS
 * Code iframe. On mobile, each value shows exactly one pane.
 */
export type FrontendTab = 'ai' | 'shell' | 'code';

export const defaultFrontendTab: FrontendTab = 'ai';

const allowedTabValues: ReadonlyArray<FrontendTab> = [
    'ai',
    'shell',
    'code',
];

/**
 * Search params allowed on the URL.
 *
 * - `tab` — `'ai' | 'shell' | 'code'`. Only kept on repo-selection routes (`/<repoName>` or
 *   `/<repoName>/<worktreeName>`); stripped everywhere else. Absent param ⇒ `ai` (default).
 *
 * Stored as `ReadonlyArray<string>` because `URLSearchParams` allows repeats. We always normalize
 * to a single-element array so url-vir serializes as `?tab=ai` (with the `=`).
 */
export type FrontendSearchParams =
    | Readonly<{
          tab?: ReadonlyArray<FrontendTab>;
      }>
    | undefined;

export type AppRoute = Readonly<FullSpaRoute<FrontendPaths, FrontendSearchParams, undefined>>;

function isRepoSelectionRoute(paths: ReadonlyArray<string>): boolean {
    return paths.length >= 1 && paths[0] !== 'book';
}

function isFrontendTab(value: string): value is FrontendTab {
    return (allowedTabValues as ReadonlyArray<string>).includes(value);
}

function sanitizeSearch(
    paths: ReadonlyArray<string>,
    rawSearch: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): FrontendSearchParams {
    if (!rawSearch || !isRepoSelectionRoute(paths)) {
        return undefined;
    }
    const tabRaw = rawSearch.tab?.[0];
    if (tabRaw && isFrontendTab(tabRaw)) {
        return {
            tab: [tabRaw],
        };
    }
    return undefined;
}

/**
 * Read the currently-active tab from a route, falling back to {@link defaultFrontendTab} when the
 * search param is absent or the URL isn't a repo-selection route.
 */
export function tabFromRoute(route: AppRoute): FrontendTab {
    const tab = route.search?.tab?.[0];
    return tab && isFrontendTab(tab) ? tab : defaultFrontendTab;
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
