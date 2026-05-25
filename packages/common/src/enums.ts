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
