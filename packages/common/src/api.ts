// cspell:words forgejo, gitea, numstat, unstages

import {defineApi, defineEndpoint, defineWebSocket, HttpMethod, HttpStatus} from '@rest-vir/api';
import {
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    unionShape,
} from 'object-shape-tester';
import {
    mapSchemaToShape,
    type FromSchemaDefaultOptions,
    type JSONSchema,
    type SchemaShapeToType,
} from 'schema-vir';
import {
    DiffLayout,
    ForgeType,
    GitDiffSide,
    GitFileChange,
    GitHubCheckState,
    GitHubCommentTarget,
    GitHubPollingDisableReason,
    GitHubPrState,
    GitHubReaction,
    GitHubReviewState,
    ManualReviewStatus,
    PaneKind,
    PaneStatus,
    PrStatus,
    SidebarGrouping,
    SidebarSorting,
    WatchModeStatus,
} from './enums.js';

const stringMessageShape = defineShape('');

/**
 * Client → host messages on the `/pty` socket are raw keystroke / paste data written directly to
 * the pty, `{resize: {cols, rows}}` carrying the xterm viewport's current dimensions (the host
 * pushes those through to `node-pty` so the spawned shell wraps at the right column), or `{colors}`
 * carrying the terminal palette after a light ↔ dark flip — same values as the `foreground` /
 * `background` search params, re-sent because the socket outlives a theme change.
 */
const ptyClientMessageShape = defineShape(
    unionShape(
        '',
        {
            resize: {
                cols: 0,
                rows: 0,
            },
        },
        {
            colors: {
                foreground: '',
                background: '',
            },
        },
    ),
);

/**
 * The settings for each git forge, nested under `forges` in {@link configJsonSchema}. A complete
 * `Record` so a new {@link ForgeType} doesn't compile until someone decides its settings.
 */
const forgeSettingsJsonSchemas = {
    [ForgeType.Github]: {
        type: 'object',
        additionalProperties: false,
        title: 'GitHub',
        properties: {
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
                        enum: [
                            GitHubPollingDisableReason.RateLimited,
                            GitHubPollingDisableReason.Unauthenticated,
                        ],
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
            /**
             * Extra bot logins, beside the built-in review bots in `github-raw-enums.ts`, whose PR
             * review threads watch mode works on without the viewer's 👍 and whose PRs count as
             * trusted authors.
             */
            trustedBotLogins: {
                type: 'array',
                default: [],
                title: 'Trusted bots',
                description:
                    'GitHub logins of bots to trust like repo collaborators, as GitHub shows them on a review comment (e.g. "flax-bot"; a trailing "[bot]" is ignored). Watch mode acts on their review threads without your 👍. Copilot, Claude, and Codex are always trusted.',
                items: {
                    type: 'string',
                    title: 'Bot login',
                },
            },
        },
        required: [
            'disabledGitHubPolling',
            'githubPollingAutoDisable',
            'trustedBotLogins',
        ],
    },
    [ForgeType.Gitea]: {
        type: 'object',
        additionalProperties: false,
        title: 'Gitea',
        properties: {},
    },
    [ForgeType.Forgejo]: {
        type: 'object',
        additionalProperties: false,
        title: 'Forgejo',
        properties: {},
    },
    [ForgeType.Gitlab]: {
        type: 'object',
        additionalProperties: false,
        title: 'GitLab',
        properties: {},
    },
} as const satisfies Record<ForgeType, JSONSchema>;

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
 *
 * `additionalProperties` must stay `false` here: `mapSchemaToShape` throws outright on a schema
 * that defines both `properties` and a permissive `additionalProperties`. The settings form relaxes
 * it on its own copy instead — see `formJsonSchema` in `vir-settings-modal.element.ts`.
 */
export const configJsonSchema = {
    type: 'object',
    additionalProperties: false,
    title: 'agent-storm config',
    properties: {
        /**
         * Every AI the user has defined: a display name, the command that resumes its last
         * conversation, the command that starts a fresh one, and an optional avatar. Managed
         * entirely through the "Define AI" modal, so it's hidden from the settings JSON form.
         */
        aiDefinitions: {
            type: 'array',
            default: [],
            title: 'AI definitions',
            items: {
                type: 'object',
                additionalProperties: false,
                title: 'AI',
                properties: {
                    /** Opaque and stable: every override references an AI by this, never by name. */
                    id: {
                        type: 'string',
                        title: 'Id',
                    },
                    name: {
                        type: 'string',
                        title: 'Name',
                    },
                    resumeSessionCommand: {
                        type: 'string',
                        title: 'Resume session command',
                        description:
                            'Launched when an AI pane spawns for an existing tab (e.g. `claude --continue`).',
                    },
                    /**
                     * Used instead of `resumeSessionCommand` when the pane is deliberately starting
                     * over: a tab the user just created. Empty falls back to
                     * `resumeSessionCommand`.
                     */
                    newSessionCommand: {
                        type: 'string',
                        title: 'New session command',
                        description: 'Launched for a brand-new tab (e.g. `claude`).',
                    },
                    /**
                     * Bare filename inside the avatars directory, not a path — the file is read
                     * back through `/ai/avatar`. Absent when the user hasn't dropped an image.
                     */
                    avatarFile: {
                        type: 'string',
                        title: 'Avatar file',
                    },
                },
                required: [
                    'id',
                    'name',
                    'resumeSessionCommand',
                    'newSessionCommand',
                ],
            },
        },
        /**
         * Which definition every folder falls back to. Empty (or naming a deleted definition)
         * resolves to the first entry in `aiDefinitions`, so the default is never dangling.
         */
        defaultAiId: {
            type: 'string',
            default: '',
            title: 'Default AI',
            description:
                'Id of the AI used by folders with no override. Set from the Settings modal.',
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
        /**
         * Per-folder AI choice, set from the "Change AI" modal. A worktree with no entry inherits
         * its worktree-root's entry, and a folder with neither falls back to `defaultAiId`.
         */
        folderAiIds: {
            type: 'array',
            default: [],
            title: 'Folder AI overrides',
            items: {
                type: 'object',
                additionalProperties: false,
                title: 'Folder AI override',
                properties: {
                    folder: {
                        type: 'string',
                        title: 'Folder',
                    },
                    aiId: {
                        type: 'string',
                        title: 'AI id',
                    },
                },
                required: [
                    'folder',
                    'aiId',
                ],
            },
        },
        /**
         * Settings scoped to one git forge. Each forge gets its own shape rather than one shared
         * shape, because forges name and mark things differently (GitHub's `[bot]` login suffix is
         * GitHub's alone).
         */
        forges: {
            type: 'object',
            additionalProperties: false,
            title: 'Git forges',
            properties: forgeSettingsJsonSchemas,
            required: [
                ForgeType.Github,
                ForgeType.Gitea,
                ForgeType.Forgejo,
                ForgeType.Gitlab,
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
                SidebarSorting.Activity,
            ],
            default: SidebarSorting.Name,
            title: 'Sidebar sorting',
            description:
                'How the sidebar orders folders. "name" sorts alphabetically; "date" puts the most recently created repos and worktrees first; "activity" puts the ones you most recently typed into first. Selectable from the filter icon next to the Add button in the sidebar as well.',
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
        /** Sticky companion to `diffLayout`, written by the Diff pane's collapse button. */
        diffCollapseUnchanged: {
            type: 'boolean',
            default: true,
            title: 'Collapse unchanged lines',
            description:
                'When on, the Diff pane folds long runs of unchanged lines between changes. Toggled by the collapse button in the Diff pane toolbar.',
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
        /**
         * Path to a TLS certificate. When set, the vite dev server serves the frontend over https
         * with it, pairing it with the key file of the same name — see `readTlsOptions` in
         * `packages/frontend/configs/vite.config.ts`. Empty (the default) stays on http.
         *
         * Rendered by the settings modal as its own field rather than through the JSON form, so a
         * path that doesn't exist can report an error under the input. Intentionally absent from
         * `required` so configs written by older builds still load.
         */
        tlsCertPath: {
            type: 'string',
            default: '',
            title: 'HTTPS certificate path',
            description:
                'Path to a .crt file. When set, the frontend is served over https using this certificate and the .key file of the same name beside it. Leave empty to serve over http.',
        },
    },
    required: [
        'aiDefinitions',
        'defaultAiId',
        'postWorktreeCmd',
        'repos',
        'folderAiIds',
        'forges',
        'useWebgl',
        'terminalClickableLinks',
        'sidebarGrouping',
    ],
} as const satisfies JSONSchema;

export const configShape = mapSchemaToShape(configJsonSchema);

/**
 * Live status of one session tab. Reported per session rather than only per pane so a pane with
 * several tabs can show which one is actually working — the folder-level `panes` fields collapse
 * every session of a kind into one value and would mark every tab busy when any single one is.
 */
export const paneSessionStatusShape = defineShape({
    kind: enumShape(PaneKind),
    sessionId: '',
    status: enumShape(PaneStatus),
});

/** One status per pane kind, reducing every session of that kind in a folder to one value. */
export const paneStatusesShape = defineShape({
    [PaneKind.Ai]: enumShape(PaneStatus),
    [PaneKind.Shell]: enumShape(PaneStatus),
} satisfies Record<PaneKind, unknown>);

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
    /**
     * Id of the AI this folder resolves to — the backend already walked the per-folder override →
     * worktree-root override → `defaultAiId` chain, so the frontend never recreates that lookup.
     * Empty when the user has defined no AI at all.
     */
    aiId: '',
    branch: nullableShape(''),
    git: {
        dirty: false,
        notPushed: false,
    },
    prUrl: nullableShape(''),
    prStatus: enumShape(PrStatus),
    panes: paneStatusesShape,
    /**
     * Per-session statuses behind the reduced `panes` values above, one entry per session the
     * daemon currently holds a PTY for. A session with no PTY yet has no entry at all.
     */
    sessionStatuses: [paneSessionStatusShape],
    /**
     * Milliseconds since epoch of the last keystroke the user sent to any of this folder's panes,
     * used by the sidebar's "Sort by activity" option. `0` for a folder nobody has typed in since
     * the activity store was created, which sorts the folder last.
     */
    lastActivityAtMs: 0,
    watchMode: {
        status: enumShape(WatchModeStatus),
        /** Why watch mode stopped or paused, or what it's waiting on. */
        message: '',
    },
});

/**
 * A request, made by an AI running in agent-storm, for every open frontend to switch to `folder`.
 * Each frontend acts on a given `requestId` once.
 */
const folderActivationShape = defineShape({
    folder: '',
    requestId: '',
});

const foldersResponseShape = defineShape({
    folders: [folderInfoShape],
    /** Only set for a short while after the request is made. */
    folderActivation: nullableShape(folderActivationShape),
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
    /**
     * Per-tab AI override, set from the tab's "Change AI" item. Empty means the tab uses whatever
     * its folder resolves to. Lives with the session rather than in config because it's per-tab app
     * state, exactly like `name`.
     */
    aiId: '',
    /**
     * Agent-storm's id for the conversation this tab holds, handed to the AI process as
     * `AGENT_STORM_CONVERSATION_ID` so a wrapper script can map it to the CLI's own session id.
     * Unlike `id`, it changes whenever the tab starts a new conversation.
     */
    conversationId: '',
    /** Whether the tab's next AI spawn should use the new-session command instead of resuming. */
    isNewConversation: false,
});

/**
 * Full session list for one folder, both kinds at once. Every session mutation returns this so the
 * frontend replaces its list wholesale instead of patching and risking drift from the server's
 * ordering.
 */
export const folderSessionsShape = defineShape({
    [PaneKind.Ai]: [sessionMetaShape],
    [PaneKind.Shell]: [sessionMetaShape],
} satisfies Record<PaneKind, unknown>);

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

/** Empty `aiId` clears the tab's override, returning it to whatever its folder resolves to. */
const sessionSetAiRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: '',
    aiId: '',
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

const createWorktreeRequestShape = defineShape({
    repoPath: '',
    name: '',
    /**
     * AI chosen in the "Add worktree" modal. Null/undefined (or empty) → don't write an override
     * entry; the worktree inherits its repo's choice, or the global default.
     */
    aiId: nullableShape(''),
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

const aiAvatarUploadResponseShape = defineShape({
    /** Bare filename to store in the AI definition's `avatarFile`. */
    avatarFile: '',
});

const aiAvatarRequestShape = defineShape({
    avatarFile: '',
});

/**
 * An avatar's bytes, base64-encoded. Served through the API rather than a plain image URL because
 * every request to the backend needs the bearer header, which an `<img src>` can't carry.
 */
const aiAvatarResponseShape = defineShape({
    dataBase64: '',
    mimeType: '',
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
    /**
     * Set by the placeholder's "Show diff anyway" button to send the content of a file past
     * {@link maxDiffFileBytes} or {@link maxDiffFileLines}. Binary files ignore it — there is nothing
     * useful to render.
     */
    allowLarge: false,
});

/** Both sides of one file's diff as plain text, for the requested {@link GitDiffSide}. */
const gitDiffFileResponseShape = defineShape({
    /** Contents at `HEAD` (staged side) or in the index (unstaged side). */
    oldContent: '',
    /** Contents in the index (staged side) or the working tree (unstaged side). */
    newContent: '',
    /**
     * True for a file in one of the raster image formats the pane renders as a picture instead of
     * as text. Both content fields are empty and the image fields carry the two sides. SVG is not
     * one of them: it is text, and its diff says more than a re-render would.
     */
    isImage: false,
    /**
     * The two sides as `data:` URLs, only set when `isImage` is true, and each only when that side
     * exists — an added image has no old side and a deleted one has no new side. Inlined rather
     * than served from a URL because the old side is a git blob with no path to fetch it from.
     */
    oldImage: nullableShape(''),
    newImage: nullableShape(''),
    /**
     * True when either side is binary or past {@link maxDiffFileBytes} / {@link maxDiffFileLines}.
     * Both content fields are empty in that case and the pane shows a placeholder instead of a
     * diff.
     */
    tooLargeOrBinary: false,
    /**
     * True when the only thing stopping the diff is size, so re-requesting with `allowLarge` would
     * return real content. False for binary files, where the placeholder is the final answer.
     */
    canShowAnyway: false,
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

const gitStageAllRequestShape = defineShape({
    folder: '',
    /** Same meaning as {@link gitStageFileRequestShape}'s `side`, applied to every file on it. */
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
    /** The first few reactors' logins, so `count` can exceed its length. */
    reactors: [''],
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
    /** The base repository's owner. */
    owner: '',
    repoName: '',
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

/** Names one PR. `owner` is the base repository's owner. */
export const pullRequestRefShape = defineShape({
    owner: '',
    repoName: '',
    number: 0,
});

/** Names one PR by its head branch, which is how the manual-review skill records a review. */
export const pullRequestBranchShape = defineShape({
    owner: '',
    repoName: '',
    branchName: '',
});

const pullRequestTextShape = defineShape({
    title: '',
    /** GitHub's rendering of `title`, so inline code spans in a title survive. */
    titleHtml: '',
    url: '',
    /** The description. See {@link gitHubCommentShape}'s `bodyHtml`. */
    bodyHtml: '',
});

/** One queued PR as the Review tab shows it. */
const reviewQueuePrShape = defineShape({
    ...pullRequestRefShape.default,
    ...pullRequestTextShape.default,
    /** The head branch. */
    branchName: '',
    isDraft: false,
    /**
     * How many listed PRs this one is stacked under, through its base branch being another listed
     * PR's head. 0 for a PR that isn't stacked. A stacked PR comes right after its parent.
     */
    chainDepth: 0,
    /**
     * Where other people's reviews leave the PR, unlike a Build folder's `prStatus`, which tracks
     * the viewer's own review. `None` for a draft.
     */
    prStatus: enumShape(PrStatus),
    /** The viewer's own PRs can't get a review folder. */
    isViewerAuthor: false,
    /** GitHub has an open request for the viewer's review. */
    isAwaitingViewerReview: false,
    /** The viewer has submitted a review of the PR before. A pending review doesn't count. */
    hasViewerReviewed: false,
    /** Live pane statuses of the PR's review folder, like a Build folder's `panes`. */
    panes: paneStatusesShape,
    /** Empty when the author's account was deleted. */
    author: '',
    authorAvatarUrl: '',
    /**
     * GitHub lists the author as the repo's owner, a member of its org, or a collaborator on it, or
     * the author is a trusted review bot.
     */
    isAuthorTrusted: false,
    /** The PR's author stands in when it has no assignees, matching review-vir. */
    assignees: [
        {
            login: '',
            avatarUrl: '',
        },
    ],
});

/** The server's cached copy of the review queue, which it refreshes on its own schedule. */
export const reviewQueueResponseShape = defineShape({
    pullRequests: [reviewQueuePrShape],
    /**
     * Reviewer list only: open, non-draft PRs the viewer has reviewed, isn't assigned to, and no
     * longer has a pending review request on.
     */
    reviewedPullRequests: optionalShape([reviewQueuePrShape], {
        alsoUndefined: true,
    }),
    /** Unix milliseconds of the last successful fetch. 0 until the first one lands. */
    updatedAt: 0,
    isUpdating: false,
    /** Why the latest fetch failed. Empty when it succeeded; `pullRequests` keeps older data. */
    error: '',
});

const reviewPrRequestShape = defineShape({
    ...pullRequestRefShape.default,
    /** The server caches each PR by its repo and head branch, which the Build tab shares. */
    branchName: '',
    /** True skips the server's cache and queries GitHub. Used by the Review tab's refresh button. */
    forceRefresh: false,
});

/** Someone asking for the `gh` account's review. Empty `requester` for a deleted account. */
const reviewRequestEventShape = defineShape({
    id: '',
    requester: '',
    requesterAvatarUrl: '',
    createdAt: '',
    /** Whether an earlier request for the same account came first. */
    isReRequest: false,
});

/**
 * Someone asked to review the PR, or whose latest verdict approved it or requested changes. An
 * outstanding request outranks that person's earlier verdict.
 */
const reviewPrReviewerShape = defineShape({
    login: '',
    avatarUrl: '',
    /** `Pending` while a request is outstanding. */
    state: enumShape(GitHubReviewState),
});

const reviewPrShape = defineShape({
    /** Every reviewer, not only the `gh` account, sorted by login. */
    reviewers: [reviewPrReviewerShape],
    /** The `gh` account. */
    viewer: {
        login: '',
        avatarUrl: '',
    },
    ...pullRequestTextShape.default,
    branchName: '',
    /**
     * Only the inline and file-level threads the `gh` account started, plus every unresolved thread
     * when that account is assigned to the PR.
     */
    threads: [gitHubReviewThreadShape],
    /** Only the reviews the `gh` account submitted, oldest first. */
    reviews: [gitHubReviewShape],
    /** Only requests for the `gh` account's review, oldest first. */
    reviewRequests: [reviewRequestEventShape],
    /** Unix milliseconds of the GitHub fetch this came from. */
    fetchedAt: 0,
});

export const manualReviewStateShape = defineShape({
    status: enumShape(ManualReviewStatus),
    /** True while the skill is still running the operation that set `status`. */
    isPending: false,
    /** Unix milliseconds. */
    lastUpdatedAt: 0,
});

export type ManualReviewState = typeof manualReviewStateShape.runtimeType;

const manualReviewStateResponseShape = defineShape({
    /** Null when the skill has never recorded a review of the branch. */
    review: nullableShape(manualReviewStateShape),
});

const reviewFolderRequestShape = defineShape({
    ...pullRequestRefShape.default,
    /** False only resolves the path, so selecting a PR leaves no folder behind. */
    createFolder: false,
});

const reviewFolderResponseShape = defineShape({
    folder: '',
    pullRequest: reviewQueuePrShape,
    /** Null when the skill has never recorded a review of the PR's branch. */
    review: nullableShape(manualReviewStateShape),
});

const paneInputRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: '',
    text: '',
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

/**
 * {@link gitStageFileEndpoint} for every file on one side at once. The server walks what `git
 * status` currently reports rather than running a repo-wide `git add`, so a file that appeared
 * since the client's last status fetch is left alone instead of being staged unseen.
 */
export const gitStageAllEndpoint = defineEndpoint({
    path: '/git/stage/all',
    requests: {
        [HttpMethod.Post]: {
            requestData: gitStageAllRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * Throws away every unstaged change in the repo: each tracked file's working tree copy goes back to
 * whatever its index entry holds, and untracked files are deleted. Staged changes survive, which is
 * what separates this from {@link gitDiscardFileEndpoint}. Scoped to the reported status for the
 * same reason {@link gitStageAllEndpoint} is, and irreversible, so the frontend confirms before
 * calling it.
 */
export const gitDiscardUnstagedEndpoint = defineEndpoint({
    path: '/git/discard/unstaged',
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

/**
 * Open PRs from any repo still waiting on the `gh` account's review, in review-vir's Reviewer-list
 * order. PRs assigned to that account, and PRs review-vir greys out, are left out.
 *
 * GET answers from the server's cache, starting its auto-refresh on the first call. POST fetches
 * from GitHub first and answers once that lands.
 */
export const gitHubReviewQueueEndpoint = defineEndpoint({
    path: '/github/review-queue',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewQueueResponseShape,
                },
            },
        },
        [HttpMethod.Post]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewQueueResponseShape,
                },
            },
        },
    },
});

/**
 * Open PRs, drafts included, assigned to the `gh` account (or authored by it with no assignees), in
 * review-vir's Assignee-list order. Cached and refreshed separately from the review queue, with the
 * same GET and POST behavior as {@link gitHubReviewQueueEndpoint}.
 */
export const gitHubAssigneeQueueEndpoint = defineEndpoint({
    path: '/github/assignee-queue',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewQueueResponseShape,
                },
            },
        },
        [HttpMethod.Post]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewQueueResponseShape,
                },
            },
        },
    },
});

/**
 * Answers with the folder one queued PR is reviewed in, `~/.agent-storm/reviews/<owner>/<repo
 * name>/<PR number>`, creating it when asked, plus where the manual-review skill says its review
 * stands. The PR is looked up in the server's cached queue, so a client never names the path.
 * Errors when the PR isn't in the queue.
 */
export const gitHubReviewFolderEndpoint = defineEndpoint({
    path: '/github/review-folder',
    requests: {
        [HttpMethod.Post]: {
            requestData: reviewFolderRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewFolderResponseShape,
                },
            },
        },
    },
});

/**
 * Types the Review tab's init command for the PR's repo into its review folder's default Shell
 * session, spawning that session if it isn't running. Does nothing when no command is set.
 */
export const reviewInitEndpoint = defineEndpoint({
    path: '/review/init',
    requests: {
        [HttpMethod.Post]: {
            requestData: pullRequestRefShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * One PR's title, description, and the review threads the `gh` account started (plus all unresolved
 * threads when it's assigned to the PR). The server caches each PR until a request sets
 * `forceRefresh`.
 */
export const gitHubReviewPrEndpoint = defineEndpoint({
    path: '/github/review-pr',
    requests: {
        [HttpMethod.Post]: {
            requestData: reviewPrRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewPrShape,
                },
            },
        },
    },
});

const manualReviewCopyResponseShape = defineShape({
    /** Null until `/manual-review here` has made a copy of the folder's branch. */
    folder: nullableShape(''),
});

/** Finds the copy of a folder's branch that `/manual-review here` reviews in. */
export const manualReviewCopyEndpoint = defineEndpoint({
    path: '/git/manual-review-copy',
    requests: {
        [HttpMethod.Post]: {
            requestData: folderActionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: manualReviewCopyResponseShape,
                },
            },
        },
    },
});

/** Reads where the manual-review skill says the review of one PR branch stands. */
export const manualReviewStateEndpoint = defineEndpoint({
    path: '/review/state',
    requests: {
        [HttpMethod.Post]: {
            requestData: pullRequestBranchShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: manualReviewStateResponseShape,
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

/**
 * Line ceiling, checked separately from {@link maxDiffFileBytes} because the browser-side diff costs
 * far more per line than per byte. A 20k-line file with a quarter of its lines changed diffs in
 * about half a second; at 50k lines that is closer to three, and past that the algorithm gives up
 * on an exact answer anyway. Files over this get the placeholder, with a button to render anyway
 * for the cases where the wait is worth it.
 */
export const maxDiffFileLines = 20_000;

/**
 * Size ceiling per side for an image diff, well under the buffer the server's `git show` runs with.
 * Base64 inflates a blob by a third on its way through the JSON response, so this is about 5.5 MB
 * on the wire for the largest image that still renders.
 */
export const maxDiffImageBytes = 4 * 1024 * 1024;

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

export const reviewConfigShape = defineShape({
    /** Run in each new review checkout of a repo whose own `initCmd` is empty. */
    defaultInitCmd: '',
    repos: [
        {
            owner: '',
            repoName: '',
            initCmd: '',
        },
    ],
});

/** The Review tab's settings, kept in their own file apart from {@link configEndpoint}'s. */
export const reviewConfigEndpoint = defineEndpoint({
    path: '/review-config',
    requests: {
        [HttpMethod.Get]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewConfigShape,
                },
            },
        },
        [HttpMethod.Put]: {
            requestData: reviewConfigShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewConfigShape,
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

/**
 * Types `text` into a running pane and presses Enter. Errors rather than spawn a session that isn't
 * running.
 */
export const paneInputEndpoint = defineEndpoint({
    path: '/panes/input',
    requests: {
        [HttpMethod.Post]: {
            requestData: paneInputRequestShape,
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

export const sessionListEndpoint = defineEndpoint({
    path: '/sessions/list',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionListRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: folderSessionsShape,
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
                    responseData: folderSessionsShape,
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
                    responseData: folderSessionsShape,
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
                    responseData: folderSessionsShape,
                },
            },
        },
    },
});

/**
 * Points one tab at a specific AI (or back at its folder's choice). The caller restarts the tab's
 * pane afterward, which is what makes the new command take effect.
 */
export const sessionSetAiEndpoint = defineEndpoint({
    path: '/sessions/set-ai',
    requests: {
        [HttpMethod.Post]: {
            requestData: sessionSetAiRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: folderSessionsShape,
                },
            },
        },
    },
});

const clientErrorRequestShape = defineShape({
    /** `error.message`, or the stringified value when something other than an `Error` was thrown. */
    message: '',
    /** Absent when the thrown value carried no stack (a non-`Error` throw, or a bare event). */
    stack: nullableShape(''),
    /** Where in the frontend the error was caught, e.g. `render:vir-diff-pane` or `window.onerror`. */
    source: '',
    /** The page URL at the time of the error, so a route-specific crash is reproducible. */
    pageUrl: '',
});

/**
 * Frontend crash sink. The app runs as an installed PWA on phones and on desktop, where there is no
 * devtools console to read a stack from, so the browser ships errors here and the backend appends
 * them to a log file the developer (or an AI agent) can read.
 */
export const clientErrorEndpoint = defineEndpoint({
    path: '/client-error',
    requests: {
        [HttpMethod.Post]: {
            requestData: clientErrorRequestShape,
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

const watchModeRequestShape = defineShape({
    folder: '',
    isEnabled: false,
});

export const watchModeEndpoint = defineEndpoint({
    path: '/watch-mode',
    requests: {
        [HttpMethod.Post]: {
            requestData: watchModeRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const closeEditorWindowEndpoint = defineEndpoint({
    path: '/editor-window/close',
    requests: {
        [HttpMethod.Post]: {
            /**
             * Closes the window the manual-review skill recorded for the branch's review. Does
             * nothing when no window is open on it, or on an unsupported OS.
             */
            requestData: pullRequestBranchShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

/**
 * A comment the reviewer wrote on a diff line, stored in the manual-review skill's state file so
 * its verdict commands post it alongside the comments typed into the code.
 */
export const reviewCommentShape = defineShape({
    id: '',
    /** Relative to the top of the checkout. */
    path: '',
    /**
     * 1-based working-tree line, or `0` for a comment on the whole file (used for images and
     * binaries, which have no lines).
     */
    line: 0,
    /** Markdown. */
    body: '',
});

export type ReviewComment = typeof reviewCommentShape.runtimeType;

const reviewCommentsResponseShape = defineShape({
    comments: [reviewCommentShape],
});

const addReviewCommentRequestShape = defineShape({
    folder: '',
    path: '',
    line: 0,
    body: '',
});

const updateReviewCommentRequestShape = defineShape({
    folder: '',
    id: '',
    body: '',
});

const deleteReviewCommentRequestShape = defineShape({
    folder: '',
    id: '',
});

export const readReviewCommentsEndpoint = defineEndpoint({
    path: '/review-comments/read',
    requests: {
        [HttpMethod.Post]: {
            requestData: folderActionRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewCommentsResponseShape,
                },
            },
        },
    },
});

export const addReviewCommentEndpoint = defineEndpoint({
    path: '/review-comments/add',
    requests: {
        [HttpMethod.Post]: {
            requestData: addReviewCommentRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewCommentsResponseShape,
                },
            },
        },
    },
});

export const updateReviewCommentEndpoint = defineEndpoint({
    path: '/review-comments/update',
    requests: {
        [HttpMethod.Post]: {
            requestData: updateReviewCommentRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewCommentsResponseShape,
                },
            },
        },
    },
});

export const deleteReviewCommentEndpoint = defineEndpoint({
    path: '/review-comments/delete',
    requests: {
        [HttpMethod.Post]: {
            requestData: deleteReviewCommentRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: reviewCommentsResponseShape,
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

/**
 * Stores an avatar image dropped onto the "Define AI" modal and hands back the filename to record
 * in the definition. Separate from {@link uploadEndpoint} because those uploads are throwaway files
 * pasted into a terminal, while these have to outlive a reboot alongside the config.
 */
export const aiAvatarUploadEndpoint = defineEndpoint({
    path: '/ai/avatar/upload',
    requests: {
        [HttpMethod.Post]: {
            requestData: uploadRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: aiAvatarUploadResponseShape,
                },
            },
        },
    },
});

/** POST rather than GET so the filename travels in the body and the bearer header applies. */
export const aiAvatarEndpoint = defineEndpoint({
    path: '/ai/avatar',
    requests: {
        [HttpMethod.Post]: {
            requestData: aiAvatarRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: aiAvatarResponseShape,
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
        /**
         * The terminal's default foreground and background, as six hex digits each with no leading
         * `#` (a `#` would start a URL fragment). The host hands them to the daemon, which answers
         * a pty's OSC 10 / 11 color queries with them — see `answerColorQueries` in `pty-pool.ts`
         * for why the reply can't come from the browser. Empty means "don't answer those queries".
         */
        foreground: defineShape(''),
        background: defineShape(''),
    },
});

export const agentStormService = defineApi({
    apiName: 'agent-storm',
    endpoints: [
        configEndpoint,
        reviewConfigEndpoint,
        foldersEndpoint,
        updateCheckEndpoint,
        createWorktreeEndpoint,
        deleteWorktreeEndpoint,
        restartPaneEndpoint,
        killPanesEndpoint,
        paneInputEndpoint,
        sessionListEndpoint,
        sessionCreateEndpoint,
        sessionRenameEndpoint,
        sessionCloseEndpoint,
        sessionSetAiEndpoint,
        aiAvatarUploadEndpoint,
        aiAvatarEndpoint,
        clientErrorEndpoint,
        restartDaemonEndpoint,
        touchRepoEndpoint,
        hideRepoEndpoint,
        watchModeEndpoint,
        closeEditorWindowEndpoint,
        readReviewCommentsEndpoint,
        addReviewCommentEndpoint,
        updateReviewCommentEndpoint,
        deleteReviewCommentEndpoint,
        checkPathEndpoint,
        createPathEndpoint,
        uploadEndpoint,
        gitDiffStatusEndpoint,
        gitDiffFileEndpoint,
        gitStageFileEndpoint,
        gitStageAllEndpoint,
        gitStageHunkEndpoint,
        gitDiscardFileEndpoint,
        gitDiscardUnstagedEndpoint,
        gitDiscardHunkEndpoint,
        gitHubPrEndpoint,
        gitHubCommentEndpoint,
        gitHubReactionEndpoint,
        gitHubResolveThreadEndpoint,
        gitHubReviewQueueEndpoint,
        gitHubAssigneeQueueEndpoint,
        gitHubReviewFolderEndpoint,
        reviewInitEndpoint,
        gitHubReviewPrEndpoint,
        manualReviewStateEndpoint,
        manualReviewCopyEndpoint,
    ],
    webSockets: [ptyWebSocket],
});

export const defaultConfig = configShape.default;

/**
 * Derived directly from {@link configJsonSchema} via `json-schema-to-ts` so the runtime shape, the
 * settings modal's form schema, and this TypeScript type are all driven from the same definition.
 */
export type Config = SchemaShapeToType<
    typeof configJsonSchema,
    Omit<FromSchemaDefaultOptions, 'keepDefaultedPropertiesOptional'>
>;
export type RepoConfig = Config['repos'][number];
export type ReviewConfig = typeof reviewConfigShape.runtimeType;
export type AiDefinition = Config['aiDefinitions'][number];
export type FolderInfo = typeof folderInfoShape.runtimeType;
export type FolderActivation = typeof folderActivationShape.runtimeType;
export type PaneSessionStatus = typeof paneSessionStatusShape.runtimeType;
export type UpdateStatus = typeof updateStatusResponseShape.runtimeType;
export type SessionMeta = typeof sessionMetaShape.runtimeType;
export type FolderSessions = typeof folderSessionsShape.runtimeType;
export type PaneStatuses = typeof paneStatusesShape.runtimeType;
export type PullRequestRef = typeof pullRequestRefShape.runtimeType;
export type PullRequestBranch = typeof pullRequestBranchShape.runtimeType;
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
export type ReviewQueuePr = typeof reviewQueuePrShape.runtimeType;
export type ReviewQueue = typeof reviewQueueResponseShape.runtimeType;
export type ReviewPr = typeof reviewPrShape.runtimeType;
export type ReviewRequestEvent = typeof reviewRequestEventShape.runtimeType;
