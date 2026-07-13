import {defineApi, defineEndpoint, defineWebSocket, HttpMethod, HttpStatus} from '@rest-vir/api';
import {defineShape, enumShape, nullableShape, unionShape} from 'object-shape-tester';
import {mapSchemaToShape, type JSONSchema, type SchemaShapeToType} from 'schema-vir';
import {PaneKind, PaneStatus, SidebarGrouping} from './enums.js';

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

const paneActionRequestShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
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
export const resetAiSessionEndpoint = defineEndpoint({
    path: '/panes/reset-ai-session',
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
        resetAiSessionEndpoint,
        restartDaemonEndpoint,
        touchRepoEndpoint,
        hideRepoEndpoint,
        checkPathEndpoint,
        createPathEndpoint,
        uploadEndpoint,
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
