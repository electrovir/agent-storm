import {Change, type DiffConfig} from '@codemirror/merge';
import {Text} from '@codemirror/state';
import {linesDiffComputers} from 'vscode-diff';

/**
 * Ceiling on the algorithm's own search, after which it returns an approximate result rather than
 * running longer. Far below the value VS Code passes, because VS Code diffs in a worker and this
 * runs on the page's main thread, where every millisecond of it freezes the whole app.
 */
const maxComputationTimeMs = 1000;

/** One aligned pair of line ranges, 0-based and half-open on both sides. */
export type LineDiffRange = {
    fromA: number;
    toA: number;
    fromB: number;
    toB: number;
};

function computeChanges({
    aLines,
    bLines,
}: Readonly<{
    aLines: ReadonlyArray<string>;
    bLines: ReadonlyArray<string>;
}>) {
    /**
     * `vscode-diff` mutates neither array but types both as mutable, and its own internals index
     * them directly, so a copy is the honest way to satisfy the signature.
     */
    return linesDiffComputers.getDefault().computeDiff([...aLines], [...bLines], {
        ignoreTrimWhitespace: false,
        maxComputationTimeMs,
        computeMoves: false,
    }).changes;
}

/**
 * Line-level differences between two already-split files, as 0-based half-open ranges.
 *
 * The result is the same shape CodeMirror's own `diff` returns, but over lines instead of
 * characters, which is what a caller comparing whole lines actually wants.
 */
export function diffLines({
    aLines,
    bLines,
}: Readonly<{
    aLines: ReadonlyArray<string>;
    bLines: ReadonlyArray<string>;
}>): LineDiffRange[] {
    return computeChanges({
        aLines,
        bLines,
    }).map((change) => {
        return {
            fromA: change.original.startLineNumber - 1,
            toA: change.original.endLineNumberExclusive - 1,
            fromB: change.modified.startLineNumber - 1,
            toB: change.modified.endLineNumberExclusive - 1,
        };
    });
}

/** A line number past the last line maps to one past the end, as a trailing line start would. */
function toOffset({
    text,
    lineNumber,
    column,
}: Readonly<{
    text: Text;
    lineNumber: number;
    column: number;
}>): number {
    return (lineNumber > text.lines ? text.length + 1 : text.line(lineNumber).from) + (column - 1);
}

/**
 * The last pair diffed and its result. Mounting an editor diffs the same two documents twice in a
 * row, once in `Chunk.build` and again inside the `MergeView` or `unifiedMergeView` it hands the
 * chunks to, and on a large file each of those can take the full computation ceiling.
 */
const lastDiff: {
    current?:
        | Readonly<{
              a: string;
              b: string;
              changes: readonly Change[];
          }>
        | undefined;
} = {};

/**
 * VS Code's diff, in the shape CodeMirror's merge package expects.
 *
 * The stock algorithm is quadratic on inputs with many unaligned changes: a 13k-line
 * `package-lock.json` with a couple thousand changed lines takes over twenty seconds of blocked
 * main thread, where this one takes about 250ms and reports the same number of chunks. It also
 * produces the alignment people are used to from VS Code, since it is the same computer that editor
 * runs.
 *
 * Conversion is mechanical: the computer reports 1-based line/column ranges, CodeMirror wants
 * character offsets into the whole string. Inner (character-level) ranges are preferred where the
 * computer produced them, because those are what make a one-word edit highlight as one word instead
 * of a whole replaced line.
 */
/* eslint-disable-next-line @virmator/prefer-params-object -- CodeMirror calls this, so the two
   positional strings are its signature to dictate, not ours. */
function toCodeMirrorChanges(a: string, b: string): readonly Change[] {
    if (lastDiff.current?.a === a && lastDiff.current.b === b) {
        return lastDiff.current.changes;
    }
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const aText = Text.of(aLines);
    const bText = Text.of(bLines);
    const changes = computeChanges({
        aLines,
        bLines,
    }).flatMap((change) => {
        if (change.innerChanges?.length) {
            return change.innerChanges.map((inner) => {
                return new Change(
                    toOffset({
                        text: aText,
                        lineNumber: inner.originalRange.startLineNumber,
                        column: inner.originalRange.startColumn,
                    }),
                    toOffset({
                        text: aText,
                        lineNumber: inner.originalRange.endLineNumber,
                        column: inner.originalRange.endColumn,
                    }),
                    toOffset({
                        text: bText,
                        lineNumber: inner.modifiedRange.startLineNumber,
                        column: inner.modifiedRange.startColumn,
                    }),
                    toOffset({
                        text: bText,
                        lineNumber: inner.modifiedRange.endLineNumber,
                        column: inner.modifiedRange.endColumn,
                    }),
                );
            });
        }
        return [
            new Change(
                toOffset({
                    text: aText,
                    lineNumber: change.original.startLineNumber,
                    column: 1,
                }),
                toOffset({
                    text: aText,
                    lineNumber: change.original.endLineNumberExclusive,
                    column: 1,
                }),
                toOffset({
                    text: bText,
                    lineNumber: change.modified.startLineNumber,
                    column: 1,
                }),
                toOffset({
                    text: bText,
                    lineNumber: change.modified.endLineNumberExclusive,
                    column: 1,
                }),
            ),
        ];
    });
    lastDiff.current = {
        a,
        b,
        changes,
    };
    return changes;
}

/** Pass to every `Chunk.build` / `MergeView` / `unifiedMergeView` call so they all agree. */
export const diffConfig: DiffConfig = {
    override: toCodeMirrorChanges,
};
