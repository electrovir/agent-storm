import {type Chunk} from '@codemirror/merge';
import {type Text} from '@codemirror/state';
import {type EditorView} from '@codemirror/view';

/**
 * What a menu entry or confirmation will act on, so the scope is visible before the click. Counted
 * in lines rather than hunks when the selection narrowed every chunk it covers, because lines are
 * then what actually moves.
 */
export function stageScopeLabel(selections: ReadonlyArray<SelectedChunk>): {
    text: string;
    /** True when the label names a single thing, so a sentence can pick `this` over `these`. */
    isSingular: boolean;
} {
    if (selections.some((selection) => !selection.newLines)) {
        return {
            text: selections.length === 1 ? 'hunk' : `${selections.length} hunks`,
            isSingular: selections.length === 1,
        };
    } else {
        const lineCount = selections.reduce((total, selection) => {
            return (
                total + (selection.newLines ? selection.newLines.to - selection.newLines.from : 0)
            );
        }, 0);
        return {
            text: lineCount === 1 ? 'line' : `${lineCount} lines`,
            isSingular: lineCount === 1,
        };
    }
}

/**
 * Convert a chunk's character offsets into a 0-based, half-open line range. `to` equals `from` for
 * a chunk that covers no lines on that side (a pure insertion has an empty range in A), and a chunk
 * ending at the last line reports an offset past the end of the document, which is why the upper
 * bound is clamped to the line count rather than looked up.
 */
export function toLineRange({text, from, to}: Readonly<{text: Text; from: number; to: number}>) {
    const fromLine = text.lineAt(Math.min(from, text.length)).number - 1;
    if (to <= from) {
        return {
            from: fromLine,
            to: fromLine,
        };
    }
    return {
        from: fromLine,
        to: to > text.length ? text.lines : text.lineAt(to).number - 1,
    };
}

/**
 * The 0-based, half-open line range a character range covers. Unlike a chunk's range a selection
 * can stop anywhere, so the line it ends in counts as covered — except when it stops at that line's
 * very first column, since dragging down to the start of the next line is how a user selects the
 * lines above it.
 */
function selectionLineRange({text, from, to}: Readonly<{text: Text; from: number; to: number}>) {
    const startLine = text.lineAt(Math.min(from, text.length));
    const endLine = text.lineAt(Math.min(to, text.length));
    return {
        from: startLine.number - 1,
        to: to > from && endLine.from === to ? endLine.number - 1 : endLine.number,
    };
}

/**
 * One change to move across the index, and how much of it to move. `newLines` is a 0-based,
 * half-open range of the new document covering fewer lines than the chunk itself; undefined means
 * the whole chunk.
 */
export type SelectedChunk = {
    chunk: Chunk;
    newLines:
        | Readonly<{
              from: number;
              to: number;
          }>
        | undefined;
};

/**
 * Everything a range of the new document touches, which is what turns a text selection into
 * something stageable.
 *
 * A selection inside an addition moves only the lines it covers. Anything else moves its whole
 * chunk, because the removed lines that chunk also describes cannot be selected: in the inline
 * layout they are widgets rather than document text, and in the side-by-side one they live in the
 * other editor. Staging a replacement's additions without its removals would leave the index
 * holding both copies of those lines, so the removals come along. VS Code narrows the same cases
 * and no others.
 *
 * A pure deletion covers no new-side text: it is a single point where the removed lines used to be,
 * so it counts as touched when the range reaches that point. Everything else has to genuinely
 * overlap, or a selection ending exactly where the next chunk starts would drag that chunk in too.
 */
function selectedChunksInRange({
    chunks,
    text,
    from,
    to,
}: Readonly<{
    chunks: ReadonlyArray<Chunk>;
    /** The new document, which both the offsets and the narrowed line range are against. */
    text: Text;
    from: number;
    to: number;
}>) {
    const selectedLines = selectionLineRange({
        text,
        from,
        to,
    });
    return chunks
        .filter((chunk) => {
            if (chunk.fromB === chunk.toB) {
                return chunk.fromB >= from && chunk.fromB <= to;
            }
            return from === to
                ? chunk.fromB <= from && from <= chunk.toB
                : chunk.fromB < to && chunk.toB > from;
        })
        .map((chunk) => {
            const chunkLines = toLineRange({
                text,
                from: chunk.fromB,
                to: chunk.toB,
            });
            const narrowed = {
                from: Math.max(chunkLines.from, selectedLines.from),
                to: Math.min(chunkLines.to, selectedLines.to),
            };
            /**
             * An empty range is a right-click with nothing selected, which acts on the chunk under
             * the pointer as a whole — the same thing the hover button does.
             */
            const isNarrowable = from !== to && chunk.fromA === chunk.toA;
            return {
                chunk,
                newLines: isNarrowable && narrowed.to > narrowed.from ? narrowed : undefined,
            };
        });
}

/**
 * The chunks a right-click in `view` should act on: what the selection covers when the click lands
 * inside it, otherwise the chunk under the pointer. A right-click doesn't move the caret in every
 * browser, and Chrome on macOS selects the word under it, so a selection the click missed is a
 * leftover from an earlier click rather than what the user is pointing at. Empty on unchanged code,
 * where the browser's own menu should open instead.
 */
export function chunkSelectionsAtPointer({
    view,
    chunks,
    event,
}: Readonly<{
    view: EditorView;
    chunks: ReadonlyArray<Chunk>;
    event: MouseEvent;
}>) {
    const selection = view.state.selection.main;
    const pointerPosition = view.posAtCoords({
        x: event.clientX,
        y: event.clientY,
    });
    return selectedChunksInRange({
        chunks,
        text: view.state.doc,
        ...(pointerPosition != undefined &&
        (selection.empty || pointerPosition < selection.from || pointerPosition > selection.to)
            ? {
                  from: pointerPosition,
                  to: pointerPosition,
              }
            : {
                  from: selection.from,
                  to: selection.to,
              }),
    });
}
