import {diffReviewSideShape} from '@agent-storm/common';
import {defineFolderSetting, defineNumberSetting} from '@agent-storm/core/frontend';

export const diffSidebarWidth = {
    min: 140,
    max: 700,
    default: 260,
} as const;

/** The Diff tab's memory, shared by every Diff tab. */
export const diffMemory = {
    sidebarWidth: defineNumberSetting({
        key: 'agent-storm:diff-sidebar-width',
        bounds: diffSidebarWidth,
    }),
    /**
     * Which file each folder's diff pane was last showing, as that pane's own side-plus-path select
     * value. A value naming a file that no longer has a diff is discarded when the pane next reads
     * git status.
     */
    fileByFolder: defineFolderSetting({
        key: 'agent-storm:diff-file-by-folder',
        valueShape: '',
    }),
    /**
     * Which side each folder's diff pane was last reading as one stacked review, or `false` for a
     * folder that was last on a single-file diff. A folder with no entry opens the unstaged
     * review.
     */
    reviewSideByFolder: defineFolderSetting({
        key: 'agent-storm:diff-review-side-by-folder',
        valueShape: diffReviewSideShape,
    }),
};
