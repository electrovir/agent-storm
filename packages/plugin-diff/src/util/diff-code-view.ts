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
}>;

/**
 * Draws a Diff tab's open file in place of the built-in CodeMirror view, which lacks comments and
 * the stage menu.
 */
export type RenderDiffCodeView = (params: DiffCodeViewParams) => HtmlInterpolation;
