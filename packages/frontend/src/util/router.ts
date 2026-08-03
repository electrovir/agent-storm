import {PaneKind} from '@agent-storm/common';
import {PathTree, SpaRouter, type FullSpaRoute} from 'spa-router-vir';
import {localStorageClient} from './local-storage-client.js';

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
 * - `tab` — `'ai' | 'shell' | 'diff'`. Only kept on repo-selection routes (`/<repoName>` or
 *   `/<repoName>/<worktreeName>`); stripped everywhere else. Absent param ⇒ `ai` (default).
 * - `aiSession` / `shellSession` — 1-based index of the active session tab within that pane. Two
 *   separate params rather than one because desktop renders the AI and Shell panes simultaneously,
 *   so "the active session" is genuinely two independent values. Absent ⇒ session 1.
 *
 * Sessions travel as search params rather than path segments for the same reason, plus a path
 * segment would be ambiguous with `:worktree-name`: `/<repoName>/2` can't be distinguished from a
 * worktree literally named `2`.
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
    return paths.length >= 1 && paths[0] !== 'book';
}

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
