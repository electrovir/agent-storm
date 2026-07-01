import {defineApi, defineEndpoint, defineWebSocket, HttpMethod, HttpStatus} from '@rest-vir/api';
import {defineShape, enumShape, nullableShape, recordShape, unionShape} from 'object-shape-tester';
import {mapSchemaToShape, type JSONSchema, type SchemaShapeToType} from 'schema-vir';
import {PaneKind, PaneStatus, RepoInspectionState, SidebarGrouping} from './enums.js';

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
                    /**
                     * The branch that's treated as the source-of-truth worktree for this repo. Its
                     * worktree is hidden from the sidebar and cannot be deleted; it's the canonical
                     * place to keep shared local-only files (e.g. `.not-committed/`) that get seeded
                     * into new worktrees. Null means no base branch is configured (no hiding, no
                     * deletion guard).
                     */
                    baseBranch: {
                        type: [
                            'string',
                            'null',
                        ],
                        default: null,
                        title: 'Base branch',
                    },
                    /**
                     * Explicit list of worktrees tracked under this repo. Source of truth for what
                     * the sidebar shows; reconciled against the filesystem when the config is saved,
                     * when a worktree is created or deleted, and at the start of each background
                     * sweep. Empty for regular (non-worktree-layout) git repos.
                     */
                    worktrees: {
                        type: 'array',
                        default: [],
                        title: 'Worktrees',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            title: 'Worktree',
                            properties: {
                                path: {
                                    type: 'string',
                                    title: 'Path',
                                },
                                /**
                                 * Whether this worktree tracks the parent repo's base branch. The
                                 * base worktree is hidden from the sidebar (it's the canonical home
                                 * for shared local-only files like `.not-committed/`) and refuses
                                 * deletion.
                                 */
                                isBase: {
                                    type: 'boolean',
                                    default: false,
                                    title: 'Is base worktree',
                                },
                                /**
                                 * Local HEAD commit SHA captured the last time the user checked the
                                 * Self-review (code) step. The progress tracker uses this to
                                 * invalidate the self-review checkbox when a new local commit moves
                                 * HEAD past what was actually reviewed. Null when the step has never
                                 * been checked or after invalidation.
                                 */
                                lastReviewedSha: {
                                    type: [
                                        'string',
                                        'null',
                                    ],
                                    default: null,
                                    title: 'Last reviewed SHA',
                                },
                                /**
                                 * Per-step booleans for the progress tracker's user-toggled merge
                                 * steps (self-QA, self-review-code, etc.). Keyed by the step's
                                 * `storageKey`. Stored on the worktree config — and so persisted in
                                 * `~/.config/agent-storm.json` — rather than in browser localStorage
                                 * so progress survives across machines / clients and so the desktop
                                 * and browser builds agree on state.
                                 */
                                mergeStepValues: {
                                    type: 'object',
                                    default: {},
                                    additionalProperties: {
                                        type: 'boolean',
                                    },
                                    title: 'Merge step values',
                                },
                            },
                            required: [
                                'path',
                                'isBase',
                                'lastReviewedSha',
                                'mergeStepValues',
                            ],
                        },
                    },
                    /**
                     * Whether this repo uses a worktree-style layout (one bare git dir + multiple
                     * checked-out worktrees under a shared root). False for regular single-checkout
                     * repos. Reconciled alongside `worktrees`; stored in config so enumeration
                     * doesn't have to re-probe the filesystem on every refresh.
                     */
                    isWorktreeLayout: {
                        type: 'boolean',
                        default: false,
                        title: 'Is worktree layout',
                    },
                },
                required: [
                    'path',
                    'postWorktreeCmd',
                    'worktrees',
                    'isWorktreeLayout',
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
        /**
         * Worktree paths the user has marked as hidden from the sidebar. Mirrors the shape of
         * `hiddenAiPane` rather than living per-worktree under `repos[].worktrees[]` so the toggle
         * surfaces with a single `putConfig` call and doesn't need a dedicated endpoint. Filtered
         * out of the sidebar's tab list unless `showHiddenWorktrees` is on; cleaned up alongside the
         * worktree's row on delete and alongside the repo's rows on remove.
         */
        hiddenWorktrees: {
            type: 'array',
            default: [],
            title: 'Hidden worktrees',
            items: {
                type: 'string',
            },
        },
        /**
         * Whether the sidebar should show worktrees marked as hidden. Optional + falsy by default so
         * the "Hidden" mark actually hides things on first use; toggled from the worktree-section
         * three-dot menu. Persisted in config (not localStorage) so the choice syncs across the
         * desktop + browser builds.
         */
        showHiddenWorktrees: {
            type: 'boolean',
            default: false,
            title: 'Show hidden worktrees',
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
        'hiddenWorktrees',
    ],
} as const satisfies JSONSchema;

const configShape = mapSchemaToShape(configJsonSchema);

export const folderInfoShape = defineShape({
    path: '',
    name: '',
    parentRepoPath: nullableShape(''),
    isWorktreeRoot: false,
    isBaseBranch: false,
    aiHidden: false,
    aiCmd: '',
    /**
     * Resolved reset-AI-session command for this folder — backend already walked the per-folder
     * override → global default lookup. Empty string when no command is configured; the sidebar
     * uses that as the "don't render the menu item" signal so the frontend never has to recreate
     * the resolution logic.
     */
    resetAiSessionCmd: '',
    /**
     * Whether the user marked this worktree as hidden from the sidebar. Mirrored from
     * `config.hiddenWorktrees`; the sidebar filters these rows out unless the "Show hidden"
     * toggle is on.
     */
    isHidden: false,
    branch: nullableShape(''),
    git: {
        dirty: false,
        notPushed: false,
    },
    prUrl: nullableShape(''),
    prMerged: false,
    /**
     * Whether the worktree has any uncommitted changes (modified, staged, or untracked files).
     * Mirrors `git.dirty`; surfaced separately so the progress tracker has a stable name to
     * invalidate self-QA / self-review checkboxes on each new edit.
     */
    hasUncommittedChanges: false,
    /** Local HEAD commit SHA for the worktree, or null when detached / not a repo. */
    localCommitHash: nullableShape(''),
    /**
     * The PR's remote head SHA from `gh pr view --json headRefOid`. Null if no PR exists or
     * GitHub polling is disabled. Lets the progress tracker tell "PR open" from "PR open AND
     * everything pushed" without having to peek at the local upstream ref.
     */
    branchCommitHash: nullableShape(''),
    /** Whether the open PR is in draft state. Undefined when no PR exists. */
    prIsDraft: false,
    /**
     * Aggregated CI verdict mirrored from `PrInfo.ciPassing`. `null` while checks are still
     * running or no checks have registered yet — the progress tracker pairs this with
     * `prCiInProgress` to tell those two cases apart.
     */
    prCiPassing: nullableShape(false),
    /**
     * True while at least one CI check is still running. Lets the UI surface a loading state
     * on the "Pass CI" step and classify the worktree as "Working" rather than
     * "Needs attention" while checks are in flight.
     */
    prCiInProgress: false,
    /**
     * Aggregated result of *review-flavoured* status checks (anything whose name matches
     * `/review/i` — same set excluded from `prCiPassing`). These are CI checks that gate on
     * "all required human approvals received", so the "Get approval" step uses this directly
     * instead of GitHub's `reviewDecision`, which would also count bot reviewers (Claude,
     * Copilot, etc.) the user doesn't actually care about.
     *
     * Null when there are no review checks on the PR (or all are still running).
     */
    prReviewCheckPassing: nullableShape(false),
    /** True while at least one review-flavoured check is still running. */
    prReviewCheckInProgress: false,
    prApproved: false,
    /**
     * True when at least one reviewer's current verdict is "changes requested" — i.e. their
     * latest review requested changes and they have NOT since been re-requested. Re-requesting a
     * reviewer leaves GitHub's `reviewDecision` stuck on `CHANGES_REQUESTED`, so the server
     * resolves this per-reviewer against the pending review requests rather than trusting the
     * aggregate decision. Powers the red-exclamation failure state on the "Get approval" step.
     */
    prReviewChangesRequested: false,
    /**
     * True when reviewers have been requested but haven't yet responded
     * (`reviewDecision === 'REVIEW_REQUIRED'` with non-empty `reviewRequests`). Distinguishes
     * "waiting on humans" from "no reviewers configured" so the approval step only shows a
     * loading state when someone is actually expected to act.
     */
    prReviewPending: false,
    /**
     * True iff at least one inline review thread on the PR is still unresolved AND not
     * outdated. Outdated threads (pointing at code that no longer exists in the diff) are
     * excluded — the reviewer's concern is moot regardless of whether anyone clicked
     * "Resolve conversation". Drives the red-exclam state on the "Get approval" step
     * alongside `prReviewChangesRequested`.
     */
    prHasUnresolvedReviewComments: false,
    /**
     * True when GitHub reports the PR as having merge conflicts against its base branch
     * (`mergeable: CONFLICTING`). Drives the red-exclam failure state on the "Get approval" step —
     * the author has to resolve conflicts before the PR can land. `UNKNOWN`/`MERGEABLE` both map to
     * false so a still-computing state doesn't flash a spurious block.
     */
    prHasMergeConflicts: false,
    /** SHA captured the last time the user checked Self-review (code). Mirrors worktree config. */
    lastReviewedSha: nullableShape(''),
    /**
     * Mirrors `worktreeConfigShape.mergeStepValues` — the per-step booleans the progress tracker
     * reads for its user-toggled steps. Always populated (empty record if the worktree has never
     * had a check toggled).
     */
    mergeStepValues: recordShape({
        keys: '',
        values: false,
        partial: true,
    }),
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

const markWorktreeReviewedRequestShape = defineShape({
    worktreePath: '',
    /** SHA to record as `lastReviewedSha`, or null to clear it (e.g. on uncheck). */
    sha: nullableShape(''),
});

const setMergeStepRequestShape = defineShape({
    worktreePath: '',
    /** Step's `storageKey` (e.g. `self-qa`). Must match a non-null storageKey in mergeStepsConfig. */
    name: '',
    /** New boolean to record. Null deletes the entry — same as the un-toggled / never-set state. */
    value: nullableShape(false),
});

const okResponseShape = defineShape({
    ok: true,
});

const startTestServerRequestShape = defineShape({
    worktreePath: '',
});

const startTestServerResponseShape = defineShape({
    /** The first `http://localhost:<port>` URL the worktree's `npm start` printed. */
    port: 0,
    /** True when the child was already running and the cached port was returned without respawn. */
    reused: false,
});

const stageTrivialHunksRequestShape = defineShape({
    worktreePath: '',
});

const stageTrivialHunksResponseShape = defineShape({
    /** Combined stdout from the script — summary of what got staged / what was skipped. */
    output: '',
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

const folderPickerResponseShape = defineShape({
    path: nullableShape(''),
});

const repoInspectRequestShape = defineShape({
    path: '',
});

const repoInspectResponseShape = defineShape({
    state: enumShape(RepoInspectionState),
    currentBranch: nullableShape(''),
    workingTreeClean: false,
    /**
     * Branches present in the repo as worktrees (for already-Worktree layouts) or just the
     * single current branch (for Regular layouts that haven't been converted yet). Empty for
     * non-repo / detached states. Used by the add-repo UI to pick a base branch.
     */
    branches: [''],
    /**
     * For WorktreeChild state: the resolved parent path that should be registered as the
     * repo root. Null for every other state.
     */
    worktreeRoot: nullableShape(''),
});

const convertRepoRequestShape = defineShape({
    repoPath: '',
});

const deleteRepoRequestShape = defineShape({
    repoPath: '',
});

const clientErrorRequestShape = defineShape({
    message: '',
    stack: nullableShape(''),
    source: '',
    url: nullableShape(''),
    userAgent: nullableShape(''),
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

export const markWorktreeReviewedEndpoint = defineEndpoint({
    path: '/worktrees/mark-reviewed',
    requests: {
        [HttpMethod.Post]: {
            requestData: markWorktreeReviewedRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const setMergeStepEndpoint = defineEndpoint({
    path: '/worktrees/set-merge-step',
    requests: {
        [HttpMethod.Post]: {
            requestData: setMergeStepRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const startTestServerEndpoint = defineEndpoint({
    path: '/worktrees/test-server/start',
    requests: {
        [HttpMethod.Post]: {
            requestData: startTestServerRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: startTestServerResponseShape,
                },
            },
        },
    },
});

export const stageTrivialHunksEndpoint = defineEndpoint({
    path: '/worktrees/stage-trivial-hunks',
    requests: {
        [HttpMethod.Post]: {
            requestData: stageTrivialHunksRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: stageTrivialHunksResponseShape,
                },
            },
        },
    },
});

export const folderPickerEndpoint = defineEndpoint({
    path: '/folder-picker',
    requests: {
        [HttpMethod.Post]: {
            responses: {
                [HttpStatus.Ok]: {
                    responseData: folderPickerResponseShape,
                },
            },
        },
    },
});

export const repoInspectEndpoint = defineEndpoint({
    path: '/repos/inspect',
    requests: {
        [HttpMethod.Post]: {
            requestData: repoInspectRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: repoInspectResponseShape,
                },
            },
        },
    },
});

export const convertRepoEndpoint = defineEndpoint({
    path: '/repos/convert-to-worktree',
    requests: {
        [HttpMethod.Post]: {
            requestData: convertRepoRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const deleteRepoEndpoint = defineEndpoint({
    path: '/repos/delete',
    requests: {
        [HttpMethod.Post]: {
            requestData: deleteRepoRequestShape,
            responses: {
                [HttpStatus.Ok]: {
                    responseData: okResponseShape,
                },
            },
        },
    },
});

export const clientErrorEndpoint = defineEndpoint({
    path: '/client-errors',
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
        checkPathEndpoint,
        createPathEndpoint,
        uploadEndpoint,
        markWorktreeReviewedEndpoint,
        setMergeStepEndpoint,
        startTestServerEndpoint,
        stageTrivialHunksEndpoint,
        folderPickerEndpoint,
        repoInspectEndpoint,
        convertRepoEndpoint,
        deleteRepoEndpoint,
        clientErrorEndpoint,
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
export type RepoInspection = typeof repoInspectResponseShape.runtimeType;
