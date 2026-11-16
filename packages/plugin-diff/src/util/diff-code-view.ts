import {type HtmlInterpolation} from 'element-vir';
import {type GitDiffFileContents} from '../diff-api.js';

/** What a Diff tab hands the view that draws its open file's diff. */
export type DiffCodeViewParams = Readonly<{
    /** Identifies the open file across polls; a new key is a new file. */
    fileKey: string | undefined;
    path: string | undefined;
    /** Undefined while the file loads, which leaves the previous file's diff in place. */
    content: GitDiffFileContents | undefined;
    hideWhitespace: boolean;
    unified: boolean;
    collapseUnchanged: boolean;
    softWrap: boolean;
    isDark: boolean;
    /**
     * The newest scroll the change arrows asked for. Each new `requestId` scrolls once, so the same
     * chunk can be jumped back to.
     */
    chunkScroll:
        | Readonly<{
              chunkIndex: number;
              requestId: number;
          }>
        | undefined;
    /**
     * True while the pane shows something else in the view's place. The view stays mounted, so a
     * poll that changes nothing keeps its scroll position.
     */
    isHidden: boolean;
    /** Reports how many chunks the drawn diff has, for the toolbar's change arrows. */
    setChunkCount: (chunkCount: number) => void;
    /** False when a right-click on a change should open the browser's own menu instead. */
    canStage: boolean;
    /** A right-click landed on a changed line: opens the stage menu for the change holding it. */
    requestHunkMenu: (request: HunkMenuRequest) => void;
}>;

/** Where a right-click on a changed line landed. */
export type HunkMenuRequest = Readonly<{
    x: number;
    y: number;
    /** 1-based, counted in the old file for a removed line and in the new file otherwise. */
    lineNumber: number;
    isRemovedLine: boolean;
}>;

/**
 * Draws a Diff tab's files in place of the built-in CodeMirror view, both the open file and each
 * file of the stacked review. Comments still only show in the built-in view.
 */
export type RenderDiffCodeView = (params: DiffCodeViewParams) => HtmlInterpolation;
