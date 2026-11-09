import {type Chunk} from '@codemirror/merge';
import {type EditorView} from '@codemirror/view';
import {unsafeCSS, type CSSResult} from 'element-vir';

/** One mark on the overview ruler: where a chunk sits in the file and what kind of change it is. */
export type RulerMark = {
    topPercent: number;
    heightPercent: number;
    color: CSSResult;
};

/**
 * VS Code's overview ruler colors: `editorGutter.addedBackground` (`#48985D`) and
 * `editorGutter.deletedBackground` (which falls through to `editorError.foreground`, `#E51400`),
 * each at the 0.6 alpha the ruler applies. A replacement is both a removal and an addition, so its
 * mark is split rather than given a third color that has to be learned.
 */
const rulerColors = {
    inserted: unsafeCSS('rgba(72, 152, 93, 0.6)'),
    deleted: unsafeCSS('rgba(229, 20, 0, 0.6)'),
    modified: unsafeCSS('linear-gradient(rgba(229, 20, 0, 0.6) 50%, rgba(72, 152, 93, 0.6) 50%)'),
};

/** Smallest visible ruler mark, so a one-line change in a huge file is still clickable. */
const minRulerMarkPercent = 0.8;

/**
 * Marks are placed by asking the editor where each chunk actually sits, not by dividing line
 * numbers. Wrapped lines and, in the inline layout, the deleted-text widgets mean a line's share of
 * the file is nothing like its share of the scroll height — going by line number puts a mark next
 * to unrelated code.
 */
export function toRulerMarks(view: EditorView, chunks: ReadonlyArray<Chunk>) {
    const totalHeight = Math.max(1, view.contentHeight);
    return chunks.map((chunk) => {
        const start = view.lineBlockAt(Math.min(chunk.fromB, view.state.doc.length));
        const end = view.lineBlockAt(Math.min(chunk.toB, view.state.doc.length));
        return {
            topPercent: (start.top / totalHeight) * 100,
            heightPercent: Math.max(
                minRulerMarkPercent,
                ((end.bottom - start.top) / totalHeight) * 100,
            ),
            color:
                chunk.fromA === chunk.toA
                    ? rulerColors.inserted
                    : chunk.fromB === chunk.toB
                      ? rulerColors.deleted
                      : rulerColors.modified,
        };
    });
}
