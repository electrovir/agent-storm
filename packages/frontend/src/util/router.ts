import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {PathTree, SpaRouter, type FullSpaRoute} from 'spa-router-vir';

/**
 * Top-level app tab, rendered as the vertical tab strip left of the sidebar and carried as the
 * first path segment so a tab selection survives a reload or a shared link.
 */
export enum MainTab {
    Dashboard = 'dashboard',
    Build = 'build',
    Review = 'review',
    /** Element-book pages for checking UI states. Only in the strip when enabled in settings. */
    Debug = 'debug',
}

export const defaultMainTab = MainTab.Dashboard;

/** Tab order in the strip, top to bottom, which is the enum's declaration order. */
export const orderedMainTabs = getEnumValues(MainTab);

export const mainTabLabels: Record<MainTab, string> = {
    [MainTab.Dashboard]: 'Dashboard',
    [MainTab.Build]: 'Build',
    [MainTab.Review]: 'Review',
    [MainTab.Debug]: 'Debug',
};

/**
 * The valid shape of the in-app URL.
 *
 * - `/dashboard` — default experience: the Build and Review lists side by side.
 * - `/build` — the Build tab, nothing selected.
 * - `/build/<repoName>` — a standalone (non-worktree) repo selected. If the segment matches a repo
 *   that _has_ worktrees, the route is invalid; `vir-app` redirects back to `/build` once it has
 *   folder info to make that determination.
 * - `/build/<repoName>/<worktreeName>` — a worktree under a worktree-root repo selected.
 * - `/review` — the Review tab, nothing selected.
 * - `/review/<owner>/<repoName>/<prNumber>` — one pull request in the review queue selected.
 * - `/debug/<...>` — the Debug tab, which shows the element-book inside the app chrome. Redirected to
 *   the default tab while the Debug tab is disabled in settings.
 * - `/book/<...>` — the element-book route, deliberately left outside the tab strip: it replaces the
 *   whole app chrome, so nesting it under a tab would be a lie (and would break existing deep
 *   links).
 *
 * The `:repo-name` / `:worktree-name` segments are dynamic — sanitization keeps whatever value the
 * user typed and lets `vir-app` resolve it against the live folder list.
 */
export const frontendPathTree = new PathTree({
    /**
     * A bare `/` isn't a valid route, which is what makes sanitization rewrite it — and any URL
     * whose first segment isn't recognized, including pre-tab links like `/<repoName>` — to the
     * first child below, the Dashboard tab.
     */
    allowBare: false,
    children: {
        [MainTab.Dashboard]: {},
        [MainTab.Build]: {
            allowBare: true,
            children: {
                ':repo-name': {
                    allowBare: true,
                    children: {
                        ':worktree-name': {},
                    },
                },
            },
        },
        [MainTab.Review]: {
            allowBare: true,
            children: {
                ':owner': {
                    allowBare: true,
                    children: {
                        ':repo-name': {
                            allowBare: true,
                            children: {
                                ':pr-number': {},
                            },
                        },
                    },
                },
            },
        },
        [MainTab.Debug]: {
            anyChildren: true,
        },
        book: {
            anyChildren: true,
        },
    },
});

export type FrontendPaths = typeof frontendPathTree.PathsType;

export type AppRoute = Readonly<FullSpaRoute<FrontendPaths, undefined, undefined>>;

/**
 * Which top-level tab the URL selects. Anything that isn't explicitly another tab reads as the
 * default, so `/book/...` (outside the strip entirely) doesn't leave the strip with nothing
 * marked.
 */
export function mainTabFromRoute(route: AppRoute): MainTab {
    return check.isEnumValue(route.paths[0], MainTab) ? route.paths[0] : defaultMainTab;
}

/** Bare route for one tab, used when switching tabs with nothing to restore. */
export const bareMainTabPaths = {
    [MainTab.Dashboard]: [MainTab.Dashboard],
    [MainTab.Build]: [MainTab.Build],
    [MainTab.Review]: [MainTab.Review],
    [MainTab.Debug]: [MainTab.Debug],
} as const satisfies Record<MainTab, FrontendPaths>;

export const router = new SpaRouter<FrontendPaths, undefined, undefined>({
    sanitizeRoute(rawRoute) {
        const paths = frontendPathTree.sanitizePaths(rawRoute.paths);
        return {
            paths,
            search: undefined,
            hash: undefined,
        };
    },
});

export type AppRouteUpdate = Parameters<typeof router.setRoute>[0];
