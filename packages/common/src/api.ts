import {AnyOrigin, defineService, HttpMethod} from '@rest-vir/define-service';
import {defineShape, enumShape, nullableShape, tupleShape, unionShape} from 'object-shape-tester';
import {mapSchemaToShape, type JSONSchema, type SchemaShapeToType} from 'schema-vir';
import {PaneKind, PaneStatus, SidebarGrouping} from './enums.js';

const port = 41_880;

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

const ptySearchParamsShape = defineShape({
    folder: tupleShape(''),
    kind: tupleShape(enumShape(PaneKind)),
});

/**
 * The WebSocket upgrade can't carry an `Authorization` header from a browser, but it _can_ carry
 * subprotocols. The auth bearer rides in `Sec-WebSocket-Protocol`; the server validates it and
 * sends back this same value to complete the upgrade handshake.
 */
const ptyProtocolsShape = defineShape(tupleShape(''));

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

const repoTouchRequestShape = defineShape({
    /**
     * Path of the activated folder. Can be a top-level repo path OR a worktree path — the backend
     * resolves to the owning repo before stamping its `lastInteractedAtMs`. Folders not present in
     * config (e.g. stale paths, freshly-deleted worktrees) are silently no-op'd.
     */
    folder: '',
});

export const agentStormService = defineService({
    serviceName: 'agent-storm',
    serviceOrigin: `http://localhost:${port}`,
    requiredClientOrigin: AnyOrigin,
    endpoints: {
        '/config': {
            methods: {
                [HttpMethod.Get]: true,
                [HttpMethod.Put]: true,
            },
            requestDataShape: nullableShape(configShape),
            responseDataShape: configShape,
        },
        '/folders': {
            methods: {
                [HttpMethod.Get]: true,
            },
            requestDataShape: undefined,
            responseDataShape: foldersResponseShape,
        },
        '/worktrees/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: createWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/worktrees/delete': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: deleteWorktreeRequestShape,
            responseDataShape: okResponseShape,
        },
        '/panes/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: paneActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/panes/kill': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: folderActionRequestShape,
            responseDataShape: okResponseShape,
        },
        '/daemon/restart': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: undefined,
            responseDataShape: okResponseShape,
        },
        '/repos/touch': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: repoTouchRequestShape,
            responseDataShape: okResponseShape,
        },
        '/paths/check': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: pathRequestShape,
            responseDataShape: pathCheckResponseShape,
        },
        '/paths/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: pathRequestShape,
            responseDataShape: pathCreateResponseShape,
        },
        '/uploads/create': {
            methods: {
                [HttpMethod.Post]: true,
            },
            requestDataShape: uploadRequestShape,
            responseDataShape: uploadResponseShape,
        },
    },
    webSockets: {
        '/pty': {
            messageFromClientShape: ptyClientMessageShape,
            messageFromHostShape: stringMessageShape,
            searchParamsShape: ptySearchParamsShape,
            protocolsShape: ptyProtocolsShape,
        },
    },
});

export const defaultConfig = configShape.default;

/**
 * Derived directly from {@link configJsonSchema} via `json-schema-to-ts` so the runtime shape, the
 * settings modal's form schema, and this TypeScript type are all driven from the same definition.
 */
export type Config = SchemaShapeToType<typeof configJsonSchema, NonNullable<unknown>>;
export type RepoConfig = Config['repos'][number];
export type FolderInfo = typeof folderInfoShape.runtimeType;
