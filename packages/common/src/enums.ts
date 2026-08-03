export enum PaneKind {
    Ai = 'ai',
    Shell = 'shell',
}

export enum PaneStatus {
    /** No PTY has ever been started for this pane. */
    None = 'none',
    /** PTY is alive and producing output recently. */
    Busy = 'busy',
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
 * time (newest first), falling back to name for folders the backend couldn't stat.
 *
 * The first variant is the default (`enumShape` picks the first value when the field is absent from
 * config), so `Name` stays as the out-of-the-box behavior.
 */
export enum SidebarSorting {
    Name = 'name',
    Date = 'date',
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
