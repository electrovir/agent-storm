import {PaneKind} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {getEnumValues, omitObjectKeys} from '@augment-vir/common';
import {PathTree, SpaRouter, type FullSpaRoute} from 'spa-router-vir';
import {defaultFrontendTab, FrontendTab} from './frontend-tab.js';
import {localStorageClient} from './local-storage-client.js';

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

/**
 * Search params allowed on the URL.
 *
 * - `tab` — a {@link FrontendTab}. Only kept on routes that show a pane group (a selected repo or a
 *   selected pull request); stripped everywhere else. Absent param ⇒ `ai` (default).
 * - `aiSession` / `shellSession` — 1-based index of the active session tab within that pane. Two
 *   separate params rather than one because desktop renders the AI and Shell panes simultaneously,
 *   so "the active session" is genuinely two independent values. Absent ⇒ session 1.
 *
 * Sessions travel as search params rather than path segments for the same reason, plus a path
 * segment would be ambiguous with `:worktree-name`: `/build/<repoName>/2` can't be distinguished
 * from a worktree literally named `2`.
 *
 * Stored as `ReadonlyArray<string>` because `URLSearchParams` allows repeats. We always normalize
 * to a single-element array so url-vir serializes as `?tab=ai` (with the `=`).
 */
export type FrontendSearchParams =
    | Readonly<{
          tab?: ReadonlyArray<FrontendTab>;
          aiSession?: ReadonlyArray<string>;
          shellSession?: ReadonlyArray<string>;
      }>
    | undefined;

/** Search-param name carrying each pane kind's active session index. */
export const sessionSearchParamByKind = {
    [PaneKind.Ai]: 'aiSession',
    [PaneKind.Shell]: 'shellSession',
} as const satisfies Record<PaneKind, keyof NonNullable<FrontendSearchParams>>;

export type AppRoute = Readonly<FullSpaRoute<FrontendPaths, FrontendSearchParams, undefined>>;

function isPaneGroupRoute(paths: ReadonlyArray<string>): boolean {
    return (
        (paths[0] === MainTab.Build && paths.length >= 2) ||
        (paths[0] === MainTab.Review && paths.length === 4)
    );
}

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

/**
 * A session param is valid only as a positive integer index. Anything else (a stray string, `0`, a
 * negative) is dropped rather than clamped so the URL never keeps a value the UI won't honor.
 */
function toSessionIndex(raw: string | undefined): number | undefined {
    const parsed = Number(raw);
    return raw && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function sanitizeSearch(
    paths: ReadonlyArray<string>,
    rawSearch: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): FrontendSearchParams {
    if (!rawSearch || !isPaneGroupRoute(paths)) {
        return undefined;
    }
    const tabRaw = rawSearch.tab?.[0];
    const tab = check.isEnumValue(tabRaw, FrontendTab) ? tabRaw : undefined;
    const aiSession = toSessionIndex(rawSearch.aiSession?.[0]);
    const shellSession = toSessionIndex(rawSearch.shellSession?.[0]);
    if (!tab && !aiSession && !shellSession) {
        return undefined;
    }
    return {
        ...(tab
            ? {
                  tab: [tab],
              }
            : {}),
        ...(aiSession
            ? {
                  aiSession: [
                      String(aiSession),
                  ],
              }
            : {}),
        ...(shellSession
            ? {
                  shellSession: [
                      String(shellSession),
                  ],
              }
            : {}),
    };
}

/**
 * Read the currently-active tab from a route, falling back to {@link defaultFrontendTab} when the
 * search param is absent or the URL isn't a repo-selection route.
 */
export function tabFromRoute(route: AppRoute): FrontendTab {
    const tab = route.search?.tab?.[0];
    return check.isEnumValue(tab, FrontendTab) ? tab : defaultFrontendTab;
}

/**
 * 1-based index of the active session for one pane kind, defaulting to the first session. The index
 * is resolved against the folder's live session list by the pane group — an index past the end
 * falls back to the first session there, since the URL can outlive the sessions it referenced.
 */
export function sessionIndexFromRoute(route: AppRoute, kind: PaneKind): number {
    return toSessionIndex(route.search?.[sessionSearchParamByKind[kind]]?.[0]) ?? 1;
}

/**
 * The tab a folder was last viewed on. Folders are remembered independently so switching to another
 * repo and back lands on the pane you were using there.
 */
export function rememberedTabForFolder(folder: string): FrontendTab {
    return localStorageClient.tabByFolder.readFolder(folder) ?? defaultFrontendTab;
}

/**
 * The session tab a folder's pane was last on, or 1 when it has never been set. Stored per folder
 * and per pane kind for the same reason the tab is: coming back to a repo should land on the
 * session you were working in there, and the AI and Shell panes are shown side by side on desktop
 * so they each need their own answer.
 *
 * The index is only ever a hint. The pane group checks it against the folder's live session list
 * and corrects the route when the session it names is gone, which is what writes the reset back
 * here.
 */
export function rememberedSessionIndexForFolder(folder: string, kind: PaneKind): number {
    return localStorageClient.sessionIndexByFolder.readFolder(folder)?.[kind] ?? 1;
}

export function rememberSessionIndexForFolder({
    folder,
    kind,
    index,
}: Readonly<{
    folder: string;
    kind: PaneKind;
    index: number;
}>): void {
    /** Index 1 is the fallback, so storing it would only be dead weight to read back. */
    const byKind =
        index > 1
            ? {
                  ...localStorageClient.sessionIndexByFolder.readFolder(folder),
                  [kind]: index,
              }
            : omitObjectKeys(localStorageClient.sessionIndexByFolder.readFolder(folder) ?? {}, [
                  kind,
              ]);
    localStorageClient.sessionIndexByFolder.writeFolder({
        folder,
        value: Object.keys(byKind).length ? byKind : undefined,
    });
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

export type AppRouteUpdate = Parameters<typeof router.setRoute>[0];

/** Remembers `tab` as `memoryKey`'s pane tab and shows it, keeping the current route's paths. */
export function selectPaneTab({
    memoryKey,
    tab,
}: Readonly<{
    memoryKey: string;
    tab: FrontendTab;
}>) {
    const route = router.readCurrentRoute();
    const existingSearch = route.search ?? {};
    localStorageClient.tabByFolder.writeFolder({
        folder: memoryKey,
        value: tab,
    });
    router.setRoute({
        paths: route.paths,
        /**
         * Omit `?tab` from the URL when the requested tab is the default — keeps URLs short and
         * matches what `tabFromRoute` falls back to anyway. Either branch carries the session
         * params through: switching between CLI and Code shouldn't reset which session each pane is
         * showing.
         */
        search:
            tab === defaultFrontendTab
                ? omitObjectKeys(existingSearch, ['tab'])
                : {
                      ...existingSearch,
                      tab: [tab],
                  },
    });
}

/**
 * Remembers the 1-based `index` as `memoryKey`'s session tab for `kind` and shows it, keeping the
 * current route's paths.
 */
export function selectPaneSession({
    memoryKey,
    kind,
    index,
}: Readonly<{
    memoryKey: string;
    kind: PaneKind;
    index: number;
}>) {
    /**
     * Session selection lives in the URL alongside `tab`, so a reload or a shared link lands on the
     * same session. Index 1 is omitted for the same reason the default tab is: it's what the
     * fallback resolves to anyway.
     */
    const paramName = sessionSearchParamByKind[kind];
    const route = router.readCurrentRoute();
    const existingSearch = route.search ?? {};
    rememberSessionIndexForFolder({
        folder: memoryKey,
        kind,
        index,
    });
    router.setRoute({
        paths: route.paths,
        /**
         * Index 1 drops the param rather than setting it to `undefined`: the search type marks
         * these optional, so an explicit `undefined` isn't assignable.
         */
        search:
            index > 1
                ? {
                      ...existingSearch,
                      [paramName]: [
                          String(index),
                      ],
                  }
                : omitObjectKeys(existingSearch, [
                      paramName,
                  ]),
    });
}
