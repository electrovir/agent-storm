import {PaneKind} from '@agent-storm/common';
import {omitObjectKeys} from '@augment-vir/common';
import {PathTree, SpaRouter, type FullSpaRoute} from 'spa-router-vir';
import {localStorageClient} from './local-storage-client.js';

/**
 * Top-level app tab, rendered as the vertical tab strip left of the sidebar and carried as the
 * first path segment so a tab selection survives a reload or a shared link.
 */
export enum MainTab {
    WriteCode = 'write-code',
    ReviewCode = 'review-code',
}

export const defaultMainTab = MainTab.WriteCode;

/** Tab order in the strip, top to bottom. */
export const orderedMainTabs: ReadonlyArray<MainTab> = [
    MainTab.WriteCode,
    MainTab.ReviewCode,
];

export const mainTabLabels: Record<MainTab, string> = {
    [MainTab.WriteCode]: 'Write Code',
    [MainTab.ReviewCode]: 'Review Code',
};

/**
 * The valid shape of the in-app URL.
 *
 * - `/write-code` — default experience, nothing selected.
 * - `/write-code/<repoName>` — a standalone (non-worktree) repo selected. If the segment matches a
 *   repo that _has_ worktrees, the route is invalid; `vir-app` redirects back to `/write-code` once
 *   it has folder info to make that determination.
 * - `/write-code/<repoName>/<worktreeName>` — a worktree under a worktree-root repo selected.
 * - `/review-code` — the Review Code tab, which has no contents yet.
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
     * first child below, the Write Code tab.
     */
    allowBare: false,
    children: {
        [MainTab.WriteCode]: {
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
        [MainTab.ReviewCode]: {},
        book: {
            anyChildren: true,
        },
    },
});

export type FrontendPaths = typeof frontendPathTree.PathsType;

/**
 * Which pane the user is focused on. On desktop, `ai` and `shell` both render the "CLI" tab with
 * both panes visible side-by-side (their difference doesn't affect the layout); `diff` shows the
 * diff viewer and `github` the PR review pane. On mobile, each value shows exactly one pane.
 *
 * `github` stays a valid URL value even for folders with no PR (where the tab isn't rendered) — the
 * pane group falls back to the CLI layout in that case rather than the URL being rewritten, so the
 * tab reappears if a PR shows up on the next poll.
 */
export type FrontendTab = 'ai' | 'shell' | 'diff' | 'github';

export const defaultFrontendTab: FrontendTab = 'ai';

const allowedTabValues: ReadonlyArray<FrontendTab> = [
    'ai',
    'shell',
    'diff',
    'github',
];

/**
 * Search params allowed on the URL.
 *
 * - `tab` — `'ai' | 'shell' | 'diff'`. Only kept on repo-selection routes (`/write-code/<repoName>`
 *   or `/write-code/<repoName>/<worktreeName>`); stripped everywhere else. Absent param ⇒ `ai`
 *   (default).
 * - `aiSession` / `shellSession` — 1-based index of the active session tab within that pane. Two
 *   separate params rather than one because desktop renders the AI and Shell panes simultaneously,
 *   so "the active session" is genuinely two independent values. Absent ⇒ session 1.
 *
 * Sessions travel as search params rather than path segments for the same reason, plus a path
 * segment would be ambiguous with `:worktree-name`: `/write-code/<repoName>/2` can't be
 * distinguished from a worktree literally named `2`.
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

function isRepoSelectionRoute(paths: ReadonlyArray<string>): boolean {
    return paths[0] === MainTab.WriteCode && paths.length >= 2;
}

/**
 * Which top-level tab the URL selects. Anything that isn't explicitly another tab reads as the
 * default, so `/book/...` (outside the strip entirely) doesn't leave the strip with nothing
 * marked.
 */
export function mainTabFromRoute(route: AppRoute): MainTab {
    return route.paths[0] === MainTab.ReviewCode ? MainTab.ReviewCode : defaultMainTab;
}

/** Bare route for one tab, used when switching tabs with nothing to restore. */
export const bareMainTabPaths = {
    [MainTab.WriteCode]: [MainTab.WriteCode],
    [MainTab.ReviewCode]: [MainTab.ReviewCode],
} as const satisfies Record<MainTab, FrontendPaths>;

function isFrontendTab(value: string): value is FrontendTab {
    return (allowedTabValues as ReadonlyArray<string>).includes(value);
}

/**
 * A session param is valid only as a positive integer index. Anything else (a stray string, `0`, a
 * negative) is dropped rather than clamped so the URL never keeps a value the UI won't honor.
 */
function sanitizeSessionIndex(raw: string | undefined): string | undefined {
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 1 ? String(parsed) : undefined;
}

function sanitizeSearch(
    paths: ReadonlyArray<string>,
    rawSearch: Readonly<Record<string, ReadonlyArray<string>>> | undefined,
): FrontendSearchParams {
    if (!rawSearch || !isRepoSelectionRoute(paths)) {
        return undefined;
    }
    const tabRaw = rawSearch.tab?.[0];
    const tab = tabRaw && isFrontendTab(tabRaw) ? tabRaw : undefined;
    const aiSession = sanitizeSessionIndex(rawSearch.aiSession?.[0]);
    const shellSession = sanitizeSessionIndex(rawSearch.shellSession?.[0]);
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
                  aiSession: [aiSession],
              }
            : {}),
        ...(shellSession
            ? {
                  shellSession: [shellSession],
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
    return tab && isFrontendTab(tab) ? tab : defaultFrontendTab;
}

/**
 * 1-based index of the active session for one pane kind, defaulting to the first session. The index
 * is resolved against the folder's live session list by the pane group — an index past the end
 * falls back to the first session there, since the URL can outlive the sessions it referenced.
 */
export function sessionIndexFromRoute(route: AppRoute, kind: PaneKind): number {
    const raw = route.search?.[sessionSearchParamByKind[kind]]?.[0];
    const parsed = Number(raw);
    return raw && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * The tab a folder was last viewed on. Folders are remembered independently so switching to another
 * repo and back lands on the pane you were using there.
 */
export function rememberedTabForFolder(folder: string): FrontendTab {
    const remembered = localStorageClient.tabByFolder.read()[folder];
    return remembered && isFrontendTab(remembered) ? remembered : defaultFrontendTab;
}

export function rememberTabForFolder({
    folder,
    tab,
}: Readonly<{
    folder: string;
    tab: FrontendTab;
}>): void {
    localStorageClient.tabByFolder.write({
        ...localStorageClient.tabByFolder.read(),
        [folder]: tab,
    });
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
    return localStorageClient.sessionIndexByFolder.read()[folder]?.[kind] ?? 1;
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
    const stored = localStorageClient.sessionIndexByFolder.read();
    /** Index 1 is the fallback, so storing it would only be dead weight to read back. */
    const byKind =
        index > 1
            ? {
                  ...stored[folder],
                  [kind]: index,
              }
            : omitObjectKeys(stored[folder] ?? {}, [kind]);
    localStorageClient.sessionIndexByFolder.write(
        Object.keys(byKind).length
            ? {
                  ...stored,
                  [folder]: byKind,
              }
            : omitObjectKeys(stored, [folder]),
    );
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
