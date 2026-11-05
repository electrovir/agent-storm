/**
 * Which pane the user is focused on. On desktop, `ai` and `shell` both render the "CLI" tab with
 * both panes visible side-by-side (their difference doesn't affect the layout); `diff` shows the
 * diff viewer. `review` shows the AI pane beside the Review pane, and only exists for a folder
 * whose branch has a PR. On mobile, each value shows exactly one pane.
 */
export enum FrontendTab {
    Ai = 'ai',
    Shell = 'shell',
    Diff = 'diff',
    Review = 'review',
}

export const defaultFrontendTab = FrontendTab.Ai;
