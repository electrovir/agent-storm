import {ManualReviewStatus, type ManualReviewState} from '@agent-storm/common';
import {getObjectTypedValues} from '@augment-vir/common';
import {
    createSizedIcon,
    LucideColumns2Icon,
    LucideFileDiffIcon,
    LucideScanEyeIcon,
    LucideSquareTerminalIcon,
    type ViraIconSvg,
} from 'vira';
import {FrontendTab} from './frontend-tab.js';

/** A verdict can only be posted while the skill holds a review that hasn't posted yet. */
export const canPostVerdictByStatus: Readonly<Record<ManualReviewStatus, boolean>> = {
    [ManualReviewStatus.Started]: true,
    [ManualReviewStatus.Approved]: false,
    [ManualReviewStatus.RequestedChanges]: false,
    [ManualReviewStatus.Commented]: false,
    [ManualReviewStatus.PostFailed]: true,
    [ManualReviewStatus.Aborted]: false,
};

export type PaneTabButton = {
    label: string;
    /** Undefined for the AI tab, which has no icon of its own. */
    icon: ViraIconSvg | undefined;
    tab: FrontendTab;
    isActive: boolean;
};

/**
 * Which panes a folder's pane group shows and mounts for the tab in the URL, and the tab buttons
 * that select them.
 *
 * - Desktop, tab=ai|shell → both AI + Shell visible (the split layout).
 * - Desktop, tab=diff → diff pane visible (both terminals hidden).
 * - Desktop review folder, tab=shell → AI + Shell visible. Any other tab → AI + Review.
 * - Desktop Build folder with a PR, tab=review → AI + Review visible.
 * - Mobile, tab=ai → only AI pane visible.
 * - Mobile, tab=shell → only Shell pane visible.
 * - Mobile, tab=diff → only diff pane visible.
 * - Mobile, tab=review → only Review pane visible.
 *
 * A review folder's Diff tab is held back until its manual review's startup has finished.
 */
export function resolvePaneLayout({
    activeTab,
    isMobile,
    isReviewFolder,
    hasPr,
    review,
}: Readonly<{
    activeTab: FrontendTab;
    isMobile: boolean;
    isReviewFolder: boolean;
    /** Whether a Build folder's branch has a PR, which gives the folder a Review tab. */
    hasPr: boolean;
    review: Readonly<ManualReviewState> | undefined;
}>) {
    /** Before the review branch exists, the folder's diff is meaningless or empty. */
    const isReviewDiffReady =
        !!review &&
        review.status !== ManualReviewStatus.Aborted &&
        !(review.status === ManualReviewStatus.Started && review.isPending);
    const hasDiffTab = !isReviewFolder || isReviewDiffReady;
    const isDiffTab = hasDiffTab && activeTab === FrontendTab.Diff;
    const hasReviewTab = isReviewFolder || hasPr;
    /** A review folder opens on its Review pane, so on desktop every tab but `shell` shows it. */
    const isReviewPaneTab =
        !isDiffTab &&
        hasReviewTab &&
        (isMobile || !isReviewFolder
            ? activeTab === FrontendTab.Review
            : activeTab !== FrontendTab.Shell);
    const showAiPane = !isDiffTab && (!isMobile || activeTab === FrontendTab.Ai);
    const showShellPane =
        !isDiffTab && !isReviewPaneTab && (!isMobile || activeTab === FrontendTab.Shell);

    /**
     * Tab bar layout differs by screen size:
     *
     * - Desktop: CLI + Diff. The CLI tab is the active one when `activeTab` is `ai` or `shell` — the
     *   user can't tell them apart on desktop (both panes are visible) so we collapse them into one
     *   button. Clicking CLI sets `tab=ai` as a stable default.
     * - Mobile: AI, Shell, Diff, each mapping directly to the URL param.
     *
     * A Build folder with a PR also gets a Review tab, after Diff.
     */
    const cliTabButtons: ReadonlyArray<PaneTabButton> = isMobile
        ? [
              {
                  label: 'AI',
                  icon: undefined,
                  tab: FrontendTab.Ai,
                  isActive: showAiPane,
              },
              {
                  label: 'Shell',
                  icon: createSizedIcon(LucideSquareTerminalIcon, 14),
                  tab: FrontendTab.Shell,
                  isActive: showShellPane,
              },
          ]
        : [
              {
                  label: 'CLI',
                  icon: createSizedIcon(LucideColumns2Icon, 14),
                  tab: isReviewFolder ? FrontendTab.Shell : FrontendTab.Ai,
                  isActive: showShellPane,
              },
          ];
    const diffTabButtons: ReadonlyArray<PaneTabButton> = hasDiffTab
        ? [
              {
                  label: 'Diff',
                  icon: createSizedIcon(LucideFileDiffIcon, 14),
                  tab: FrontendTab.Diff,
                  isActive: isDiffTab,
              },
          ]
        : [];
    const reviewTabButton: PaneTabButton = {
        label: 'Review',
        icon: createSizedIcon(LucideScanEyeIcon, 14),
        tab: isReviewFolder && !isMobile ? FrontendTab.Ai : FrontendTab.Review,
        isActive: isReviewPaneTab,
    };

    return {
        isDiffTab,
        hasReviewTab,
        isReviewPaneTab,
        showAiPane,
        showShellPane,
        /**
         * Whether to actually mount each terminal (vs. just hide it with CSS). On desktop both are
         * always mounted so the split view is live and switching tabs is instant. On mobile only
         * the visible pane's terminal is mounted, so an inactive folder never holds a socket and
         * even the active folder holds at most one `/pty` WebSocket at a time — switching
         * tabs/panes closes the old socket (the daemon keeps the PTY and replays scrollback on the
         * next attach). This keeps phones from accumulating idle sockets.
         */
        mountAiTerminal: !isMobile || showAiPane || isReviewFolder,
        /** A review folder only spawns its shell once the shell is first shown. */
        mountShellTerminal: (!isMobile && !isReviewFolder) || showShellPane,
        tabButtons: isReviewFolder
            ? [
                  ...(isMobile ? cliTabButtons.slice(0, 1) : []),
                  reviewTabButton,
                  ...diffTabButtons,
                  ...(isMobile ? cliTabButtons.slice(1) : cliTabButtons),
              ]
            : [
                  ...cliTabButtons,
                  ...diffTabButtons,
                  ...(hasReviewTab
                      ? [
                            reviewTabButton,
                        ]
                      : []),
              ],
    };
}

/** Which checkout a Build folder's Diff tab shows. */
export enum DiffView {
    Source = 'source',
    /** The copy of the branch that `/manual-review here` reviews in. */
    ManualReview = 'manualReview',
}

/**
 * The view a Build folder's Diff tab shows: `chosen` when it has something to show, else whichever
 * view does, else Source. A chosen ManualReview view is kept while `isManualReviewStarting`, so the
 * tab stays on it while the review copy is still being made.
 */
export function resolveDiffView({
    chosen,
    hasChanges,
    reviewCopyFolder,
    review,
    isManualReviewStarting,
}: Readonly<{
    chosen: DiffView;
    /** Whether the folder has any uncommitted change, staged or not. */
    hasChanges: boolean;
    reviewCopyFolder: string | undefined;
    review: Readonly<ManualReviewState> | undefined;
    isManualReviewStarting: boolean;
}>) {
    const isAvailable: Readonly<Record<DiffView, boolean>> = {
        [DiffView.Source]: hasChanges,
        /** A copy left over from an earlier review would otherwise show a finished review. */
        [DiffView.ManualReview]:
            !!reviewCopyFolder && !!review && canPostVerdictByStatus[review.status],
    };
    const isManualReviewSelectable = isAvailable[DiffView.ManualReview] || isManualReviewStarting;
    return {
        diffView:
            isAvailable[chosen] || (chosen === DiffView.ManualReview && isManualReviewSelectable)
                ? chosen
                : getObjectTypedValues(DiffView).find((view) => isAvailable[view]) ||
                  DiffView.Source,
        isAvailable,
        isManualReviewSelectable,
    };
}
