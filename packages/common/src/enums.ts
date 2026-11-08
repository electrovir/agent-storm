// cspell:words forgejo, gitea

export enum PaneKind {
    Ai = 'ai',
    Shell = 'shell',
}

/**
 * Whether a pane kind runs an AI. Only those tabs hold a conversation, which can be resumed or
 * started over.
 */
export const paneKindRunsAi: Readonly<Record<PaneKind, boolean>> = {
    [PaneKind.Ai]: true,
    [PaneKind.Shell]: false,
};

/** What a tab in a folder's pane layout shows. AI and shell tabs each run one terminal session. */
export enum PaneTabKind {
    Ai = 'ai',
    Shell = 'shell',
    Diff = 'diff',
    Review = 'review',
}

/** How a split in a pane layout lays out its children. */
export enum SplitDirection {
    /** Side by side, left to right. */
    Row = 'row',
    /** Stacked, top to bottom. */
    Column = 'column',
}

/** The edge of a tab group a dragged tab is dropped on, which splits the group on that side. */
export enum SplitEdge {
    Left = 'left',
    Right = 'right',
    Top = 'top',
    Bottom = 'bottom',
}

export enum PaneStatus {
    /** No PTY has ever been started for this pane. */
    None = 'none',
    /**
     * PTY is alive and producing output recently, or Claude's hooks report unfinished work that is
     * still showing signs of life.
     */
    Busy = 'busy',
    /**
     * Claude's hooks report unfinished work (a turn or background tasks), but nothing has shown
     * signs of life for a while, so it may be hung.
     */
    Stalled = 'stalled',
    /** PTY is alive but has been quiet for a moment. */
    Idle = 'idle',
    /** PTY process exited (the pane shows its last buffered output). */
    Exited = 'exited',
}

/**
 * How the sidebar arranges its folder list. `Repo` keeps the existing layout (each repo's worktrees
 * nested under their root). `Status` regroups folders by their AI pane's current {@link PaneStatus}
 * regardless of which repo they belong to. The actual regrouping logic isn't wired up yet — this is
 * just the user's preference, persisted in config.
 *
 * The first variant is the default (object-shape-tester's `enumShape` picks the first value when
 * the field is absent from config), so `Repo` stays as the out-of-the-box behavior.
 */
export enum SidebarGrouping {
    Repo = 'repo',
    Status = 'status',
}

/**
 * How the sidebar orders folders within each group. `Date` uses each folder's filesystem creation
 * time (newest first), falling back to name for folders the backend couldn't stat. `Activity` uses
 * the last time the user typed into any of the folder's panes, falling back to name for folders
 * nobody has typed in.
 *
 * The first variant is the default (`enumShape` picks the first value when the field is absent from
 * config), so `Name` stays as the out-of-the-box behavior.
 */
export enum SidebarSorting {
    Name = 'name',
    Date = 'date',
    Activity = 'activity',
}

/**
 * How the Diff pane lays out a file's two versions. `Auto` picks by screen size — inline on a
 * phone, side-by-side otherwise — and is what a config with no stored choice falls back to.
 */
export enum DiffLayout {
    Auto = 'auto',
    Split = 'split',
    Inline = 'inline',
}

/**
 * How a file in the Diff pane differs on one side of the index. Derived from a single letter of
 * `git status --porcelain`'s two-letter code — the index column for a staged entry, the worktree
 * column for an unstaged one.
 */
export enum GitFileChange {
    Added = 'added',
    Modified = 'modified',
    Deleted = 'deleted',
    Renamed = 'renamed',
    Untracked = 'untracked',
}

/**
 * Which pair of trees a diff compares. `Staged` is `HEAD` → index (what a commit would contain);
 * `Unstaged` is index → working tree (what a commit would leave behind). A partially-staged file
 * appears on both sides with different content, which is exactly why the pane can't collapse them
 * into one `HEAD` → working tree diff.
 */
export enum GitDiffSide {
    Staged = 'staged',
    Unstaged = 'unstaged',
}

/**
 * Lifecycle state of a pull request, flattened from GitHub's separate `state` + `isDraft` fields
 * into the one value the UI actually branches on.
 */
export enum GitHubPrState {
    Draft = 'draft',
    Open = 'open',
    Merged = 'merged',
    Closed = 'closed',
}

/**
 * Aggregate CI result for the PR's head commit, collapsed from GitHub's `statusCheckRollup.state`.
 * `None` covers both "the repo runs no checks" and "the rollup isn't computed yet".
 */
export enum GitHubCheckState {
    None = 'none',
    Pending = 'pending',
    Success = 'success',
    Failure = 'failure',
}

/** One reviewer's latest verdict on the PR. */
export enum GitHubReviewState {
    Approved = 'approved',
    ChangesRequested = 'changesRequested',
    Commented = 'commented',
    Dismissed = 'dismissed',
    Pending = 'pending',
}

/**
 * Where a new comment lands. A thread reply is addressed by the review thread's node id; a
 * conversation comment by the pull request's own node id.
 */
export enum GitHubCommentTarget {
    Thread = 'thread',
    Conversation = 'conversation',
}

/**
 * The eight reactions GitHub allows on a comment. Values are GitHub's own `ReactionContent` enum
 * literals so they can be handed straight to the `addReaction` / `removeReaction` mutations without
 * a translation table.
 */
export enum GitHubReaction {
    ThumbsUp = 'THUMBS_UP',
    ThumbsDown = 'THUMBS_DOWN',
    Laugh = 'LAUGH',
    Hooray = 'HOORAY',
    Confused = 'CONFUSED',
    Heart = 'HEART',
    Rocket = 'ROCKET',
    Eyes = 'EYES',
}

/**
 * A git host that a repo's remote can point at. Values match `ForgeType` in `forge-adapter`, which
 * replaces this once that package is published.
 */
export enum ForgeType {
    Github = 'github',
    Gitea = 'gitea',
    Forgejo = 'forgejo',
    Gitlab = 'gitlab',
}

/** Why the backend switched GitHub polling off on its own. */
export enum GitHubPollingDisableReason {
    RateLimited = 'rate-limited',
    Unauthenticated = 'unauthenticated',
}

/** Where a folder's watch mode stands. */
export enum WatchModeStatus {
    Off = 'off',
    /** Polling the PR, with nothing for the AI to do yet. */
    Watching = 'watching',
    /** An AI pass is running in the folder's Watch tab. */
    Working = 'working',
    /** Held back while the user reviews the branch or the folder's other AI tabs are busy. */
    Paused = 'paused',
}

/**
 * Where a folder's PR stands from the `gh` user's point of view. A re-requested review counts as
 * `AwaitingReview` again, or as `ReReviewRequested` when that user's latest verdict requested
 * changes.
 */
export enum PrStatus {
    None = 'none',
    AwaitingReview = 'awaitingReview',
    /** Same as `AwaitingReview` except the viewer has started a local manual review of the branch. */
    ReviewStarted = 'reviewStarted',
    /** Same as `AwaitingReview` except the viewer's latest verdict on the PR requested changes. */
    ReReviewRequested = 'reReviewRequested',
    /** Has unresolved review threads, and no verdict that outranks them. */
    UnresolvedComments = 'unresolvedComments',
    ChangesRequested = 'changesRequested',
    Approved = 'approved',
    /** The viewer wrote or approved it, but someone else requested changes. */
    OthersRequestedChanges = 'othersRequestedChanges',
    /**
     * The viewer wrote or approved it and left nothing unresolved, but a code owner that
     * pull-request-vir listed in the description hasn't approved, or GitHub still requires a
     * review.
     */
    AwaitingOtherReviews = 'awaitingOtherReviews',
    /** Same as `AwaitingOtherReviews` except every code owner approved and a check failed. */
    ChecksFailed = 'checksFailed',
    /** GitHub's merge button is green. */
    ReadyToMerge = 'readyToMerge',
    Merged = 'merged',
    /** Closed without merging. */
    Closed = 'closed',
}

/**
 * Where a review stands, as the manual-review skill records it in
 * `~/.agent-storm/manual-review/state.json`.
 */
export enum ManualReviewStatus {
    Started = 'started',
    Approved = 'approved',
    RequestedChanges = 'requestedChanges',
    Commented = 'commented',
    PostFailed = 'postFailed',
    Aborted = 'aborted',
}
