// cspell:words numstat unstages
import {definePluginApi, diffPaneId, GitDiffSide, GitFileChange} from '@agent-storm/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

const folderRequestShape = defineShape({
    folder: '',
});

const okResponseShape = defineShape({
    ok: true,
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
 * both lists at once, with different content on each side. A pull request's status fills only
 * `pullRequest` instead.
 */
const gitDiffStatusResponseShape = defineShape({
    staged: [gitDiffFileShape],
    unstaged: [gitDiffFileShape],
    pullRequest: [gitDiffFileShape],
    /** The merge-base commit `pullRequest` is compared against. */
    pullRequestBase: nullableShape(''),
});

const gitPullRequestStatusRequestShape = defineShape({
    folder: '',
    /** The branch the PR merges into. Its remote-tracking branch wins over a local one. */
    baseBranch: '',
});

const gitDiffFileRequestShape = defineShape({
    folder: '',
    /** Repo-relative path, exactly as it came back from the `readStatus` call. */
    path: '',
    /**
     * The file's pre-rename path, when it has one. Without it a renamed file has no `HEAD:<path>`
     * to read and would render as an all-new file instead of a diff.
     */
    oldPath: nullableShape(''),
    side: enumShape(GitDiffSide),
    /** The status's `pullRequestBase`. Required for the `PullRequest` side and ignored otherwise. */
    baseCommit: nullableShape(''),
    /**
     * Set by the placeholder's "Show diff anyway" button to send the content of a file past
     * `maxDiffFileBytes` or `maxDiffFileLines`. Binary files ignore it — there is nothing useful to
     * render.
     */
    allowLarge: false,
});

/** Both sides of one file's diff as plain text, for the requested {@link GitDiffSide}. */
const gitDiffFileResponseShape = defineShape({
    /** Contents at `HEAD` (staged side), in the index (unstaged side), or at the merge base. */
    oldContent: '',
    /** Contents in the index (staged side), the working tree (unstaged side), or at `HEAD`. */
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
     * True when either side is binary or past `maxDiffFileBytes` / `maxDiffFileLines`. Both content
     * fields are empty in that case and the pane shows a placeholder instead of a diff.
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
 * client got from the `readFile` call for this same `side`. The server rebuilds those two documents
 * and turns the ranges into a real patch, so a stale range fails the `git apply` instead of
 * silently staging the wrong lines.
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

/** The Diff plugin's calls into its server part, which runs git in the requested folder. */
export const diffApi = definePluginApi({
    pluginId: diffPaneId,
    calls: {
        readStatus: {
            requestShape: folderRequestShape,
            responseShape: gitDiffStatusResponseShape,
        },
        /** Every file the folder's branch committed since it split from the PR's base branch. */
        readPullRequestStatus: {
            requestShape: gitPullRequestStatusRequestShape,
            responseShape: gitDiffStatusResponseShape,
        },
        readFile: {
            requestShape: gitDiffFileRequestShape,
            responseShape: gitDiffFileResponseShape,
        },
        stageFile: {
            requestShape: gitStageFileRequestShape,
            responseShape: okResponseShape,
        },
        /**
         * Throws away every change to one file, on both sides of the index at once: the index entry
         * goes back to `HEAD` and the working tree copy follows. An untracked file is deleted,
         * since it has no `HEAD` state to return to. Irreversible, so the frontend confirms before
         * calling it.
         */
        discardFile: {
            requestShape: gitFileRequestShape,
            responseShape: okResponseShape,
        },
        /**
         * `stageFile` for every file on one side at once. The server walks what `git status`
         * currently reports rather than running a repo-wide `git add`, so a file that appeared
         * since the client's last status fetch is left alone instead of being staged unseen.
         */
        stageAll: {
            requestShape: gitStageAllRequestShape,
            responseShape: okResponseShape,
        },
        /**
         * Throws away every unstaged change in the repo: each tracked file's working tree copy goes
         * back to whatever its index entry holds, and untracked files are deleted. Staged changes
         * survive, which is what separates this from `discardFile`. Scoped to the reported status
         * for the same reason `stageAll` is, and irreversible, so the frontend confirms before
         * calling it.
         */
        discardUnstaged: {
            requestShape: folderRequestShape,
            responseShape: okResponseShape,
        },
        stageHunk: {
            requestShape: gitStageHunkRequestShape,
            responseShape: okResponseShape,
        },
        /**
         * Throws away one hunk instead of moving it across the index. Addressed exactly like
         * `stageHunk`, and irreversible for the same reason `discardFile` is, so the frontend
         * confirms before calling it.
         */
        discardHunk: {
            requestShape: gitStageHunkRequestShape,
            responseShape: okResponseShape,
        },
    },
});

export type GitDiffFile = typeof gitDiffFileShape.runtimeType;
export type GitDiffFileContents = typeof gitDiffFileResponseShape.runtimeType;
export type GitDiffStatus = typeof gitDiffStatusResponseShape.runtimeType;
