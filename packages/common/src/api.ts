// cspell:words numstat, unstages

import {defineApi, defineEndpoint, defineWebSocket, HttpMethod, HttpStatus} from '@rest-vir/api';
import {defineShape, enumShape, nullableShape, unionShape} from 'object-shape-tester';
import {mapSchemaToShape, type JSONSchema, type SchemaShapeToType} from 'schema-vir';
import {
    DiffLayout,
    GitDiffSide,
    GitFileChange,
    GitHubCheckState,
    GitHubCommentTarget,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
    PaneKind,
    PaneStatus,
    SidebarGrouping,
    SidebarSorting,
} from './enums.js';

const stringMessageShape = defineShape('');

/**
 * Client → host messages on the `/pty` socket are either raw keystroke / paste data written
 * directly to the pty, or `{resize: {cols, rows}}` carrying the xterm viewport's current
 * dimensions. The host pushes those dimensions through to `node-pty` so the spawned shell wraps at
 * the right column.
 */
const ptyClientMessageShape = defineShape(
    unionShape('', {
        resize: {
            cols: 0,
            rows: 0,
        },
    }),
);

/**
 * Single source of truth for the user-editable config. Defined as a JSON Schema so:
 *
 * 1. The runtime shape (`configShape`) and the TypeScript `Config` type are derived from it via
 *    `schema-vir` instead of being hand-written separately and drifting.
 * 2. The settings modal can import this same schema directly into `ViraJsonForm` — no parallel
 *    definition in the frontend.
 *
 * Schema-vir's `mapSchemaToShape` interprets union-type orderings (`['string', 'null']` vs
 * `['null', 'string']`) for default selection — the first arm's default wins. We keep `null` last
 * for fields whose default value is the non-null variant (matching the prior
 * `nullableShape(defaultValue)` behavior), and put `null` first only for `githubPollingAutoDisable`
 * where the absence of an auto-disable is the natural default.
 */
export const configJsonSchema = {
    type: 'object',
    additionalProperties: false,
    title: 'agent-storm config',
    properties: {
        aiCmd: {
            type: 'string',
            default: 'claude',
            title: 'AI command',
            description: 'Command launched in the AI pane (e.g. `claude`).',
        },
        /**
         * Optional global default for the "Restart AI session" menu item. When non-empty (or when a
         * per-folder override is set in `folderAiCmds`), the sidebar row menu shows the item and
         * clicking it writes this string + newline into the folder's AI pane. Intentionally absent
         * from `required` so older configs without it still load — missing → "" → no menu item.
         */
        resetAiSessionCmd: {
            type: 'string',
            default: '',
            title: 'Reset AI session command',
            description:
                'Optional. Command (e.g. `/clear`) sent into the AI pane when the user picks "Restart AI session" from a folder\'s row menu. Per-folder overrides live alongside the AI command override.',
        },
        postWorktreeCmd: {
            type: [
                'string',
                'null',
            ],
            default: '',
            title: 'Default post-worktree command',
            description:
                'Shell command run after a new worktree is created (per-repo overrides win).',
        },
        repos: {
            type: 'array',
            default: [],
            title: 'Repos',
            items: {
                type: 'object',
                additionalProperties: false,
                title: 'Repo',
                properties: {
                    path: {
                        type: 'string',
                        title: 'Path',
                    },
                    postWorktreeCmd: {
                        type: [
                            'string',
                            'null',
                        ],
                        title: 'Post-worktree command (overrides global)',
                    },
                    /**
                     * Milliseconds since epoch when the user last activated this repo (or any of
                     * its worktrees). Optional — older configs without it just won't appear in any
                     * "recently used" sort until the first activation writes the timestamp. Not in
                     * `required` for forward/backward compat: dropping the field never invalidates
                     * an existing config.
                     */
                    lastInteractedAtMs: {
                        type: 'number',
                        title: 'Last interaction (ms since epoch)',
                        description:
                            'Auto-updated when the user activates this repo or one of its worktrees in the sidebar.',
                    },
                },
                required: [
                    'path',
                    'postWorktreeCmd',
                ],
            },
        },
        folderAiCmds: {
            type: 'array',
            default: [],
            title: 'Folder AI command overrides',
            items: {
                type: 'object',
                additionalProperties: false,
                title: 'Folder AI command override',
                properties: {
                    folder: {
                        type: 'string',
                        title: 'Folder',
                    },
                    aiCmd: {
                        type: 'string',
                        title: 'AI command',
                    },
                    /**
                     * Optional per-folder override of the global `resetAiSessionCmd`. When the user
                     * picks "Restart AI session" from a row menu, this wins over the global default
                     * (and we fall back through worktree-root → global the same way `aiCmd`
                     * resolution does). Absent from `required` so an entry can exist for the
                     * `aiCmd` override alone, the reset-cmd override alone, or both.
                     */
                    resetAiSessionCmd: {
                        type: 'string',
                        title: 'Reset AI session command override',
                    },
                },
                required: [
                    'folder',
                    'aiCmd',
                ],
            },
        },
        hiddenAiPane: {
            type: 'array',
            default: [],
            title: 'Folders with AI pane hidden',
            items: {
                type: 'string',
            },
        },
        disabledGitHubPolling: {
            type: 'boolean',
            default: false,
            title: 'Disable GitHub polling',
            description:
                'When on, the sidebar skips `gh pr view` for every folder on each refresh sweep. Turn this on when GitHub is rate-limiting the account — the calls just 403 and the PR badges go stale anyway until the limit resets.',
        },
        githubPollingAutoDisable: {
            type: [
                'null',
                'object',
            ],
            default: null,
            title: 'GitHub polling auto-disable',
            description:
                "Runtime-set auto-disable state for GitHub polling, persisted across server restarts. Backend-managed; users shouldn't need to edit this.",
            properties: {
                reason: {
                    type: 'string',
                },
                disabledUntilMs: {
                    type: 'number',
                },
            },
            required: [
                'reason',
                'disabledUntilMs',
            ],
        },
        useWebgl: {
            type: 'boolean',
            default: true,
            title: 'Use WebGL terminal renderer',
            description:
                "When on, the in-app terminal uses xterm's WebGL renderer (faster on most machines). Turn off to fall back to the DOM renderer on machines without WebGL2 or with flaky GPU drivers. Reloads the page on save when changed so existing terminals pick up the new renderer.",
        },
        terminalClickableLinks: {
            type: 'boolean',
            default: true,
            title: 'Clickable terminal links',
            description:
                "When on, URLs that appear in terminal output are auto-detected and clicking them opens the link in a new browser tab. Turn off if accidental link clicks (e.g. from terminal selections or stray taps) are opening pages you didn't intend.",
        },
        sidebarGrouping: {
            type: 'string',
            enum: [
                SidebarGrouping.Repo,
                SidebarGrouping.Status,
            ],
            default: SidebarGrouping.Repo,
            title: 'Sidebar grouping',
            description:
                'How the sidebar arranges folders. "repo" keeps the existing layout (worktrees nested under their repo root); "status" regroups folders by their AI pane status. Selectable from the filter icon next to the Add button in the sidebar as well.',
        },
        sidebarSorting: {
            type: 'string',
            enum: [
                SidebarSorting.Name,
                SidebarSorting.Date,
            ],
            default: SidebarSorting.Name,
            title: 'Sidebar sorting',
            description:
                'How the sidebar orders folders. "name" sorts alphabetically; "date" puts the most recently created repos and worktrees first. Selectable from the filter icon next to the Add button in the sidebar as well.',
        },
        /**
         * Sticky Diff pane layout, written by that pane's own split/inline toggle so the choice
         * outlives a reload. Absent from `required` so older configs load; missing reads as
         * `undefined`, which the pane treats the same as `auto`.
         */
        diffLayout: {
            type: 'string',
            enum: [
                DiffLayout.Auto,
                DiffLayout.Split,
                DiffLayout.Inline,
            ],
            default: DiffLayout.Auto,
            title: 'Diff layout',
            description:
                'How the Diff pane shows a file. "auto" uses inline on a phone and side-by-side elsewhere. Also set by the layout button in the Diff pane toolbar.',
        },
        /**
         * Sticky companion to `diffLayout`, written by the Diff pane's whitespace button. Lines
         * that differ only in whitespace are shown as unchanged, the way `git diff -w` does.
         */
        diffHideWhitespace: {
            type: 'boolean',
            default: true,
            title: 'Hide whitespace changes',
            description:
                'When on, the Diff pane treats lines that differ only in spacing as unchanged. Toggled by the whitespace button in the Diff pane toolbar.',
        },
        /**
         * When on, the sidebar hides standalone repos that haven't been activated within the last 7
         * days (and have no running panes). Worktree-roots and their children are always shown
         * regardless of recency. Toggled from the filter icon's dropdown in the sidebar.
         *
         * Intentionally absent from `required` so older configs without the field load fine — a
         * missing value reads as `undefined` which is falsy, matching the `false` default.
         */
        onlyShowRecent: {
            type: 'boolean',
            default: false,
            title: 'Hide inactive repos',
            description:
                'When on, hide standalone repos with no activity in the last 7 days (and no running panes). Worktrees are always shown.',
        },
        /**
         * When on, the backend skips the periodic comparison between the local agent-storm checkout
         * and its upstream `dev` branch, and the sidebar never surfaces the "pull to update"
         * banner. Intentionally absent from `required` so older configs without the field still
         * load — a missing value reads as `undefined`, matching the `false` default (checks
         * enabled).
         */
        disableUpdateCheck: {
            type: 'boolean',
            default: false,
            title: 'Disable update checks',
            description:
                "When on, agent-storm stops checking GitHub for new commits on the dev branch and hides the sidebar's update banner.",
        },
    },
    required: [
        'aiCmd',
        'postWorktreeCmd',
        'repos',
        'folderAiCmds',
        'hiddenAiPane',
        'disabledGitHubPolling',
        'githubPollingAutoDisable',
        'useWebgl',
        'terminalClickableLinks',
        'sidebarGrouping',
    ],
} as const satisfies JSONSchema;

const configShape = mapSchemaToShape(configJsonSchema);

export const folderInfoShape = defineShape({
    path: '',
    name: '',
    parentRepoPath: nullableShape(''),
    /**
     * Filesystem creation time of the folder in milliseconds since epoch, used by the sidebar's
     * "Sort by date" option. `0` when the backend couldn't stat the folder, which sorts the folder
     * last.
     */
    createdAtMs: 0,
    isWorktreeRoot: false,
    aiHidden: false,
    aiCmd: '',
    /**
     * Resolved reset-AI-session command for this folder — backend already walked the per-folder
     * override → global default lookup. Empty string when no command is configured; the sidebar
     * uses that as the "don't render the menu item" signal so the frontend never has to recreate
     * the resolution logic.
     */
    resetAiSessionCmd: '',
    branch: nullableShape(''),
    git: {
        dirty: false,
        notPushed: false,
    },
    prUrl: nullableShape(''),
    prMerged: false,
    panes: {
        ai: enumShape(PaneStatus),
        shell: enumShape(PaneStatus),
    },
});

const foldersResponseShape = defineShape({
    folders: [folderInfoShape],
});

const folderActionRequestShape = defineShape({
    folder: '',
});

/**
 * One session tab within a folder's pane. `id` is opaque and is the third segment of the daemon's
 * pane key; the display label is `name || String(index + 1)`, so an unnamed session shows its
 * 1-based position. Order within the owning array is the tab order and therefore defines the
 * index.
 */
export const sessionMetaShape = defineShape({
    id: '',
    name: '',
});

/**
 * Full session list for one folder, both kinds at once. Every session mutation returns this so the
 * frontend replaces its list wholesale instead of patching and risking drift from the server's
 * ordering.
 */
const sessionsResponseShape = defineShape({
    ai: [sessionMetaShape],
    shell: [sessionMetaShape],
});

const sessionListRequestShape = defineShape({
    folder: '',
});

const sessionCreateRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
});

const sessionRenameRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: '',
    /** Empty clears the custom name, reverting the tab's label to its 1-based index. */
    name: '',
});

const sessionCloseRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: '',
});

/**
 * `sessionId` is optional so a browser left open across an upgrade (a phone on the LAN page, say)
 * keeps working: an omitted value resolves to the folder's first session, which is exactly the
 * single-pane behavior that client was built against.
 */
const paneActionRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: nullableShape(''),
});

/** See {@link paneActionRequestShape} for why `sessionId` is optional. */
const paneSessionFolderRequestShape = defineShape({
    folder: '',
    sessionId: nullableShape(''),
});

const createWorktreeRequestShape = defineShape({
    repoPath: '',
    name: '',
    aiCmd: nullableShape(''),
    /**
     * Optional per-worktree override of the global reset-AI-session command, collected by the "Add
     * worktree" modal alongside `aiCmd`. Null/undefined → don't write an override entry; the
     * worktree inherits the global / repo-level default.
     */
    resetAiSessionCmd: nullableShape(''),
});

const deleteWorktreeRequestShape = defineShape({
    worktreePath: '',
});

const okResponseShape = defineShape({
    ok: true,
});

const uploadRequestShape = defineShape({
    filename: '',
    dataBase64: '',
});

const uploadResponseShape = defineShape({
    path: '',
});

const pathRequestShape = defineShape({
    path: '',
});

const pathCheckResponseShape = defineShape({
    /** Server-resolved absolute path (with `~` expansion + `path.resolve`). */
    resolvedPath: '',
    /** True iff something exists at `resolvedPath` (file OR directory). */
    exists: false,
});

const pathCreateResponseShape = defineShape({
    /** Server-resolved absolute path that was created. */
    resolvedPath: '',
});

/**
 * Result of the backend's "is this checkout behind upstream `dev`?" probe. All three fields are
 * nullable: when the backend can't determine status (not a git checkout, `git ls-remote` failed,
 * the user disabled the check, etc.) every field is `null` and the sidebar suppresses its update
 * banner. `isUpToDate === false` is the only signal that triggers the banner.
 */
const updateStatusResponseShape = defineShape({
    isUpToDate: nullableShape(false),
    currentSha: nullableShape(''),
    latestSha: nullableShape(''),
});

const repoTouchRequestShape = defineShape({
    /**
     * Path of the activated folder. Can be a top-level repo path OR a worktree path — the backend
     * resolves to the owning repo before stamping its `lastInteractedAtMs`. Folders not present in
     * config (e.g. stale paths, freshly-deleted worktrees) are silently no-op'd.
     */
    folder: '',
});

/**
 * One changed file in the Diff pane's file list. `insertions` / `deletions` come from `git diff
 * --numstat` and are both `0` for untracked files (git has nothing to compare against) and for
 * binary files.
 */
const gitDiffFileShape = defineShape({
    /** Repo-relative path, always the current (post-rename) path. */
    path: '',
    change: enumShape(GitFileChange),
    /** Previous path, only set when `change` is {@link GitFileChange.Renamed}. */
    oldPath: nullableShape(''),
    insertions: 0,
    deletions: 0,
});

/**
 * The two halves of `git status`, kept separate rather than merged. A partially-staged file is in
 * both lists at once, with different content on each side.
 */
const gitDiffStatusResponseShape = defineShape({
    staged: [gitDiffFileShape],
    unstaged: [gitDiffFileShape],
});

const gitDiffFileRequestShape = defineShape({
    folder: '',
    /** Repo-relative path, exactly as it came back from {@link gitDiffStatusEndpoint}. */
    path: '',
    /**
     * The file's pre-rename path, when it has one. Without it a renamed file has no `HEAD:<path>`
     * to read and would render as an all-new file instead of a diff.
     */
    oldPath: nullableShape(''),
    side: enumShape(GitDiffSide),
});

/** Both sides of one file's diff as plain text, for the requested {@link GitDiffSide}. */
const gitDiffFileResponseShape = defineShape({
    /** Contents at `HEAD` (staged side) or in the index (unstaged side). */
    oldContent: '',
    /** Contents in the index (staged side) or the working tree (unstaged side). */
    newContent: '',
    /**
     * True when either side is binary or past {@link maxDiffFileBytes}. Both content fields are
     * empty in that case and the pane shows a placeholder instead of a diff.
     */
    tooLargeOrBinary: false,
});

const gitFileRequestShape = defineShape({
    folder: '',
    path: '',
});

const gitStageFileRequestShape = defineShape({
    folder: '',
    path: '',
    /**
     * Which direction to move the whole file. `Unstaged` means "this file is currently on the
     * unstaged side", so the operation stages it; `Staged` unstages it.
     */
    side: enumShape(GitDiffSide),
});

/**
 * One contiguous change to move across the index, addressed by the line ranges the client is
 * already displaying. Ranges are 0-based and half-open, into the `oldContent` / `newContent` the
 * client got from {@link gitDiffFileEndpoint} for this same `side`. The server rebuilds those two
 * documents and turns the ranges into a real patch, so a stale range fails the `git apply` instead
 * of silently staging the wrong lines.
 */
const gitStageHunkRequestShape = defineShape({
    folder: '',
    path: '',
    oldPath: nullableShape(''),
    side: enumShape(GitDiffSide),
    fromOldLine: 0,
    toOldLine: 0,
    fromNewLine: 0,
    toNewLine: 0,
});

/**
 * One reaction bucket on a comment. `count` is everyone's reactions of that kind;
 * `viewerHasReacted` is what makes the button a toggle rather than a duplicate-add.
 */
const gitHubReactionGroupShape = defineShape({
    reaction: enumShape(GitHubReaction),
    count: 0,
    viewerHasReacted: false,
});

/**
 * A single comment, in either a review thread or the PR's main conversation. `id` is the GraphQL
 * node id, which is what the reaction and reply mutations address. `body` is raw markdown — the
 * pane renders it as preformatted text rather than pulling in a markdown renderer or injecting
 * GitHub's `bodyHTML` into the page.
 */
const gitHubCommentShape = defineShape({
    id: '',
    author: '',
    authorAvatarUrl: '',
    body: '',
    /**
     * GitHub's own rendering of `body`, which is what github.com displays. Rendering markdown from
     * this rather than parsing `body` in the browser keeps code fences, task lists, issue
     * references, and `@mentions` looking exactly like they do on GitHub, at the cost of the
     * frontend having to scrub the HTML before it goes into the DOM.
     */
    bodyHtml: '',
    /** UTC ISO 8601, straight from GitHub. */
    createdAt: '',
    url: '',
    reactions: [gitHubReactionGroupShape],
});

/**
 * One inline review conversation, anchored to a file and line. `line` is null once the thread goes
 * outdated (GitHub can no longer map it onto the current diff), which is also when `isOutdated`
 * flips.
 */
const gitHubReviewThreadShape = defineShape({
    id: '',
    path: '',
    line: nullableShape(0),
    isResolved: false,
    isOutdated: false,
    /** False for threads the token's account isn't allowed to (un)resolve — the button disables. */
    viewerCanResolve: false,
    /** The diff excerpt GitHub anchors the thread to, as a unified patch fragment. */
    diffHunk: '',
    comments: [gitHubCommentShape],
});

/** One reviewer's latest verdict. Body is empty for a bare approval with no written summary. */
const gitHubReviewShape = defineShape({
    id: '',
    author: '',
    authorAvatarUrl: '',
    state: enumShape(GitHubReviewState),
    body: '',
    /** See {@link gitHubCommentShape}'s `bodyHtml`. */
    bodyHtml: '',
    createdAt: '',
    url: '',
});

/**
 * Someone asked to review who hasn't submitted one yet. A team request carries the team's name;
 * GitHub gives no way to tell it apart from a user by name alone, and the pane doesn't need to.
 */
const gitHubReviewRequestShape = defineShape({
    reviewer: '',
    reviewerAvatarUrl: '',
});

/**
 * A single CI entry on the PR's head commit — one GitHub Actions job, or one third-party commit
 * status. `workflow` is the owning workflow's name for an Actions job and empty for a status;
 * together with `name` it reproduces github.com's "Workflow / job" label.
 */
const gitHubCheckShape = defineShape({
    name: '',
    workflow: '',
    state: enumShape(GitHubCheckState),
    /** Link to the run's logs. Empty when GitHub didn't supply one. */
    url: '',
    /** The status's one-line summary. Actions jobs don't have one. */
    description: '',
});

const gitHubPrShape = defineShape({
    /** GraphQL node id of the PR itself — the subject a new conversation comment attaches to. */
    id: '',
    number: 0,
    url: '',
    title: '',
    /** GitHub's rendering of `title`, so inline code spans in a title survive. */
    titleHtml: '',
    /** The PR description. Empty when the author left it blank. */
    body: '',
    bodyHtml: '',
    state: enumShape(GitHubPrState),
    author: '',
    authorAvatarUrl: '',
    baseRefName: '',
    headRefName: '',
    createdAt: '',
    /** Rollup verdict across every entry in `checkRuns`. */
    checks: enumShape(GitHubCheckState),
    checkRuns: [gitHubCheckShape],
    reviews: [gitHubReviewShape],
    /** Outstanding review requests, including re-requests from someone who already reviewed. */
    reviewRequests: [gitHubReviewRequestShape],
    threads: [gitHubReviewThreadShape],
    /** Top-level conversation comments, oldest first. Review summaries are in `reviews`. */
    comments: [gitHubCommentShape],
});

/**
 * Null `pr` means "no GitHub tab for this folder": no PR on the branch, no github.com `origin`, or
 * `gh` isn't installed / authenticated. Callers can't tell those apart, and don't need to — all
 * four mean the same thing to the UI.
 */
const gitHubPrResponseShape = defineShape({
    pr: nullableShape(gitHubPrShape),
});

const gitHubPrRequestShape = defineShape({
    folder: '',
    /**
     * True skips the server's per-folder cache and queries GitHub. Used by the refresh button and
     * after posting anything, where the point is to see what actually landed.
     */
    forceRefresh: false,
});

const gitHubCommentRequestShape = defineShape({
    target: enumShape(GitHubCommentTarget),
    subjectId: '',
    body: '',
});

const gitHubReactionRequestShape = defineShape({
    /** Node id of the comment being reacted to. */
    subjectId: '',
    reaction: enumShape(GitHubReaction),
    /** True adds the viewer's reaction, false removes it. */
    add: false,
});

const gitHubResolveThreadRequestShape = defineShape({
    threadId: '',
    /** True resolves the thread, false reopens it. */
    resolved: false,
});

export const gitDiffStatusEndpoint = defineEndpoint({
    path: '/git/diff/status',
    requests: {
        [HttpMethod.Post]: {
            requestData: folderActionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: gitDiffStatusResponseShape,
                },
            },
        },
    },
});

export const gitDiffFileEndpoint = defineEndpoint({
    path: '/git/diff/file',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitDiffFileRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: gitDiffFileResponseShape,
                },
            },
        },
    },
});

export const gitStageFileEndpoint = defineEndpoint({
    path: '/git/stage/file',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitStageFileRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Throws away every change to one file, on both sides of the index at once: the index entry goes
 * back to `HEAD` and the working tree copy follows. An untracked file is deleted, since it has no
 * `HEAD` state to return to. Irreversible, so the frontend confirms before calling it.
 */
export const gitDiscardFileEndpoint = defineEndpoint({
    path: '/git/discard/file',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitFileRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const gitStageHunkEndpoint = defineEndpoint({
    path: '/git/stage/hunk',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitStageHunkRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Throws away one hunk instead of moving it across the index. Addressed exactly like
 * {@link gitStageHunkEndpoint}, and irreversible for the same reason {@link gitDiscardFileEndpoint}
 * is, so the frontend confirms before calling it.
 */
export const gitDiscardHunkEndpoint = defineEndpoint({
    path: '/git/discard/hunk',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitStageHunkRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Everything the GitHub pane shows, in one call: the PR itself, each reviewer's verdict, every
 * inline review thread, and the main conversation. One round trip because it's one GraphQL query —
 * splitting it per section would multiply the rate-limit cost for no benefit.
 */
export const gitHubPrEndpoint = defineEndpoint({
    path: '/github/pr',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitHubPrRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: gitHubPrResponseShape,
                },
            },
        },
    },
});

/** Posts a reply into a review thread, or a new top-level comment on the PR. */
export const gitHubCommentEndpoint = defineEndpoint({
    path: '/github/comment',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitHubCommentRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const gitHubReactionEndpoint = defineEndpoint({
    path: '/github/reaction',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitHubReactionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const gitHubResolveThreadEndpoint = defineEndpoint({
    path: '/github/thread/resolve',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitHubResolveThreadRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Files above this size skip content loading entirely. A multi-megabyte file would be diffed
 * character-by-character in the browser, which is exactly the mobile stall the Diff pane exists to
 * avoid.
 */
export const maxDiffFileBytes = 2 * 1024 * 1024;

export const configEndpoint = defineEndpoint({
    path: '/config',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: configShape,
                },
            },
        },
        [HttpMethod.Put]: {
            requestData: configShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: configShape,
                },
            },
        },
    },
});

export const foldersEndpoint = defineEndpoint({
    path: '/folders',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: foldersResponseShape,
                },
            },
        },
    },
});

export const updateCheckEndpoint = defineEndpoint({
    path: '/update-check',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: updateStatusResponseShape,
                },
            },
        },
    },
});

export const createWorktreeEndpoint = defineEndpoint({
    path: '/worktrees/create',
    requests: {
        [HttpMethod.Post]: {
            requestData: createWorktreeRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const deleteWorktreeEndpoint = defineEndpoint({
    path: '/worktrees/delete',
    requests: {
        [HttpMethod.Post]: {
            requestData: deleteWorktreeRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const restartPaneEndpoint = defineEndpoint({
    path: '/panes/restart',
    requests: {
        [HttpMethod.Post]: {
            requestData: paneActionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const killPanesEndpoint = defineEndpoint({
    path: '/panes/kill',
    requests: {
        [HttpMethod.Post]: {
            requestData: folderActionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Sends the configured "reset AI session" string into a folder's AI pane (per-folder override →
 * global default). Triggered by the row-menu "Restart AI session" item, which only appears when the
 * resolved command is non-empty. Returns a no-op 200 when no command is configured so a stale
 * frontend doesn't surface errors after the user clears the setting.
 */
export const sessionListEndpoint = defineEndpoint({
    path: '/sessions/list',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionListRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: sessionsResponseShape,
                },
            },
        },
    },
});

/**
 * Appends a new session to the end of the folder+kind list. The PTY is not spawned here — it spawns
 * lazily on the first `/pty` attach, matching how the original single session per pane behaves.
 */
export const sessionCreateEndpoint = defineEndpoint({
    path: '/sessions/create',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionCreateRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: sessionsResponseShape,
                },
            },
        },
    },
});

export const sessionRenameEndpoint = defineEndpoint({
    path: '/sessions/rename',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionRenameRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: sessionsResponseShape,
                },
            },
        },
    },
});

/** Drops the session from the store and kills its PTY. Closing the last session is a no-op. */
export const sessionCloseEndpoint = defineEndpoint({
    path: '/sessions/close',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionCloseRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: sessionsResponseShape,
                },
            },
        },
    },
});

export const resetAiSessionEndpoint = defineEndpoint({
    path: '/panes/reset-ai-session',
    requests: {
        [HttpMethod.Post]: {
            requestData: paneSessionFolderRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const restartDaemonEndpoint = defineEndpoint({
    path: '/daemon/restart',
    requests: {
        [HttpMethod.Post]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const touchRepoEndpoint = defineEndpoint({
    path: '/repos/touch',
    requests: {
        [HttpMethod.Post]: {
            requestData: repoTouchRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const hideRepoEndpoint = defineEndpoint({
    path: '/repos/hide',
    requests: {
        [HttpMethod.Post]: {
            /**
             * Reuses {@link repoTouchRequestShape} — same `{folder}` payload and same owning-repo
             * resolution. Clears the repo's `lastInteractedAtMs` (the inverse of touch), which the
             * sidebar treats as "hidden": dropped from the recency-filtered list while still
             * showing in search and the unfiltered view.
             */
            requestData: repoTouchRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const checkPathEndpoint = defineEndpoint({
    path: '/paths/check',
    requests: {
        [HttpMethod.Post]: {
            requestData: pathRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: pathCheckResponseShape,
                },
            },
        },
    },
});

export const createPathEndpoint = defineEndpoint({
    path: '/paths/create',
    requests: {
        [HttpMethod.Post]: {
            requestData: pathRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: pathCreateResponseShape,
                },
            },
        },
    },
});

export const uploadEndpoint = defineEndpoint({
    path: '/uploads/create',
    requests: {
        [HttpMethod.Post]: {
            requestData: uploadRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: uploadResponseShape,
                },
            },
        },
    },
});

export const ptyWebSocket = defineWebSocket({
    path: '/pty',
    clientMessage: ptyClientMessageShape,
    hostMessage: stringMessageShape,
    searchParams: {
        folder: defineShape(''),
        kind: enumShape(PaneKind),
        /**
         * Which session tab within this folder+kind to attach to. Empty resolves to the folder's
         * first session, so a client predating multi-session (or one whose session list hasn't
         * loaded yet) lands on the same PTY it always did.
         */
        sessionId: defineShape(''),
        /**
         * Max scrollback lines this client wants replayed on attach, as a decimal string (search
         * params are strings). The backend truncates the pane's buffered scrollback to the last N
         * lines before sending it, so a client that keeps a small xterm buffer doesn't pay to
         * transfer and process history it will immediately discard. Empty or invalid means "no
         * client limit" and the full buffered scrollback is replayed.
         */
        scrollbackLimit: defineShape(''),
    },
});

export const agentStormService = defineApi({
    apiName: 'agent-storm',
    endpoints: [
        configEndpoint,
        foldersEndpoint,
        updateCheckEndpoint,
        createWorktreeEndpoint,
        deleteWorktreeEndpoint,
        restartPaneEndpoint,
        killPanesEndpoint,
        sessionListEndpoint,
        sessionCreateEndpoint,
        sessionRenameEndpoint,
        sessionCloseEndpoint,
        resetAiSessionEndpoint,
        restartDaemonEndpoint,
        touchRepoEndpoint,
        hideRepoEndpoint,
        checkPathEndpoint,
        createPathEndpoint,
        uploadEndpoint,
        gitDiffStatusEndpoint,
        gitDiffFileEndpoint,
        gitStageFileEndpoint,
        gitStageHunkEndpoint,
        gitDiscardFileEndpoint,
        gitDiscardHunkEndpoint,
        gitHubPrEndpoint,
        gitHubCommentEndpoint,
        gitHubReactionEndpoint,
        gitHubResolveThreadEndpoint,
    ],
    webSockets: [ptyWebSocket],
});

export const defaultConfig = configShape.default;

/**
 * Derived directly from {@link configJsonSchema} via `json-schema-to-ts` so the runtime shape, the
 * settings modal's form schema, and this TypeScript type are all driven from the same definition.
 */
export type Config = SchemaShapeToType<typeof configJsonSchema, NonNullable<unknown>>;
export type RepoConfig = Config['repos'][number];
export type FolderInfo = typeof folderInfoShape.runtimeType;
export type UpdateStatus = typeof updateStatusResponseShape.runtimeType;
export type SessionMeta = typeof sessionMetaShape.runtimeType;
export type FolderSessions = typeof sessionsResponseShape.runtimeType;
export type GitDiffFile = typeof gitDiffFileShape.runtimeType;
export type GitDiffFileContents = typeof gitDiffFileResponseShape.runtimeType;
export type GitDiffStatus = typeof gitDiffStatusResponseShape.runtimeType;
export type GitHubPr = typeof gitHubPrShape.runtimeType;
export type GitHubComment = typeof gitHubCommentShape.runtimeType;
export type GitHubReviewThread = typeof gitHubReviewThreadShape.runtimeType;
export type GitHubReview = typeof gitHubReviewShape.runtimeType;
export type GitHubReviewRequest = typeof gitHubReviewRequestShape.runtimeType;
export type GitHubCheck = typeof gitHubCheckShape.runtimeType;
export type GitHubReactionGroup = typeof gitHubReactionGroupShape.runtimeType;
