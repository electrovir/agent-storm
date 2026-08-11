import {Change, type DiffConfig} from '@codemirror/merge';
import {linesDiffComputers} from 'vscode-diff';

/**
 * Ceiling on the algorithm's own search, after which it returns an approximate result rather than
 * running longer. Matches the value VS Code's editor passes.
 */
const maxComputationTimeMs = 5000;

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

/** Character offset each 1-based line number starts at, including the trailing entry past the end. */
function toLineStarts(lines: ReadonlyArray<string>): number[] {
    return lines.reduce<number[]>(
        (starts, line) => [
            ...starts,
            (starts.at(-1) ?? 0) + line.length + 1,
        ],
        [0],
    );
}

function toOffset({
    lineStarts,
    lineNumber,
    column,
}: Readonly<{
    lineStarts: ReadonlyArray<number>;
    lineNumber: number;
    column: number;
}>): number {
    return (lineStarts[lineNumber - 1] ?? 0) + (column - 1);
}

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
    const aLines = a.split('\n');
    const bLines = b.split('\n');
    const aStarts = toLineStarts(aLines);
    const bStarts = toLineStarts(bLines);
    return computeChanges({
        aLines,
        bLines,
    }).flatMap((change) => {
        if (change.innerChanges?.length) {
            return change.innerChanges.map(
                (inner) =>
                    new Change(
                        toOffset({
                            lineStarts: aStarts,
                            lineNumber: inner.originalRange.startLineNumber,
                            column: inner.originalRange.startColumn,
                        }),
                        toOffset({
                            lineStarts: aStarts,
                            lineNumber: inner.originalRange.endLineNumber,
                            column: inner.originalRange.endColumn,
                        }),
                        toOffset({
                            lineStarts: bStarts,
                            lineNumber: inner.modifiedRange.startLineNumber,
                            column: inner.modifiedRange.startColumn,
                        }),
                        toOffset({
                            lineStarts: bStarts,
                            lineNumber: inner.modifiedRange.endLineNumber,
                            column: inner.modifiedRange.endColumn,
                        }),
                    ),
            );
        }
        return [
            new Change(
                aStarts[change.original.startLineNumber - 1] ?? 0,
                aStarts[change.original.endLineNumberExclusive - 1] ?? 0,
                bStarts[change.modified.startLineNumber - 1] ?? 0,
                bStarts[change.modified.endLineNumberExclusive - 1] ?? 0,
            ),
        ];
    });
}

/** Pass to every `Chunk.build` / `MergeView` / `unifiedMergeView` call so they all agree. */
export const diffConfig: DiffConfig = {
    override: toCodeMirrorChanges,
};
