import {check} from '@augment-vir/assert';
import {createArray} from '@augment-vir/common';
import {diffLines, type LineDiffRange} from './vscode-diff.js';

/**
 * The old side of the diff with whitespace-only differences erased, matching `git diff -w`.
 *
 * Every old line that pairs with a new line differing only in spacing is replaced by that new
 * line's exact text, so the diff computed over the result finds nothing to mark there. Rewriting
 * the text is what makes this work everywhere at once — the marks, the change count, the jump
 * buttons, and the ruler all derive from that diff, so none of them need to know about the setting.
 * Line count is untouched, which keeps hunk staging's line math valid.
 */
export function foldWhitespaceOnlyChanges({
    oldContent,
    newContent,
}: Readonly<{
    oldContent: string;
    newContent: string;
}>): string {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    function normalize(line: string) {
        return line.replace(/\s+/g, '');
    }
    const changes = diffLines({
        aLines: oldLines.map(normalize),
        bLines: newLines.map(normalize),
    });
    /**
     * The diff reports what changed, so the aligned-and-equal runs are the gaps between its
     * changes, plus the tail after the last one.
     */
    const alignedRuns = [
        ...changes,
        undefined,
    ].map((change, index) => {
        const previous = changes[index - 1];
        const fromA = previous?.toA ?? 0;
        return {
            fromA,
            fromB: previous?.toB ?? 0,
            length: (change?.fromA ?? oldLines.length) - fromA,
        };
    });
    const foldedByLine = new Map<number, string>(
        alignedRuns.flatMap(({fromA, fromB, length}) => {
            return newLines.slice(fromB, fromB + length).map((line, offset) => {
                return [
                    fromA + offset,
                    line,
                ] as const;
            });
        }),
    );
    return oldLines.map((line, index) => foldedByLine.get(index) ?? line).join('\n');
}

/** Unchanged lines kept around each change, the same number git's own hunks carry. */
const contextLineCount = 3;

export enum DiffLineType {
    Context = 'context',
    Added = 'added',
    Removed = 'removed',
}

export type DiffHunkLine = {
    type: DiffLineType;
    /** Undefined on a line that exists only on the other side. */
    oldLineNumber: number | undefined;
    newLineNumber: number | undefined;
    text: string;
};

export type DiffHunk = {
    /** The `@@ -1,4 +1,6 @@` line, so a hunk read on its own is still placeable in the file. */
    header: string;
    lines: DiffHunkLine[];
};

/**
 * Changes whose context windows touch belong to one hunk, which is the same merge git does: two
 * edits four lines apart would otherwise print the lines between them twice.
 */
function groupChanges(changes: ReadonlyArray<LineDiffRange>): LineDiffRange[][] {
    return changes.reduce<LineDiffRange[][]>((groups, change) => {
        const current = groups.at(-1);
        const previous = current?.at(-1);
        return current && previous && change.fromA - previous.toA <= contextLineCount * 2
            ? [
                  ...groups.slice(0, -1),
                  [
                      ...current,
                      change,
                  ],
              ]
            : [
                  ...groups,
                  [
                      change,
                  ],
              ];
    }, []);
}

/**
 * Unchanged lines, which carry a number on both sides. An equal run is the same length in both
 * files, so one length and the two starts describe it.
 */
function contextLines({
    oldLines,
    fromOld,
    fromNew,
    length,
}: Readonly<{
    oldLines: ReadonlyArray<string>;
    fromOld: number;
    fromNew: number;
    length: number;
}>): DiffHunkLine[] {
    return createArray(Math.max(0, length), (index) => {
        return {
            type: DiffLineType.Context,
            oldLineNumber: fromOld + index + 1,
            newLineNumber: fromNew + index + 1,
            text: oldLines[fromOld + index] ?? '',
        };
    });
}

function toHunk({
    group,
    oldLines,
    newLines,
}: Readonly<{
    group: ReadonlyArray<LineDiffRange>;
    oldLines: ReadonlyArray<string>;
    newLines: ReadonlyArray<string>;
}>): DiffHunk | undefined {
    if (!check.isLengthAtLeast(group, 1)) {
        return undefined;
    }
    const first = group[0];
    const last = group[group.length - 1] ?? first;
    const leadingLength = Math.min(contextLineCount, first.fromA, first.fromB);
    const trailingLength = Math.min(
        contextLineCount,
        oldLines.length - last.toA,
        newLines.length - last.toB,
    );
    const startOld = first.fromA - leadingLength;
    const startNew = first.fromB - leadingLength;
    return {
        header: `@@ -${startOld + 1},${last.toA + trailingLength - startOld} +${startNew + 1},${last.toB + trailingLength - startNew} @@`,
        lines: [
            ...contextLines({
                oldLines,
                fromOld: startOld,
                fromNew: startNew,
                length: leadingLength,
            }),
            ...group.flatMap((change, index) => {
                const next = group[index + 1];
                return [
                    ...oldLines.slice(change.fromA, change.toA).map((text, offset) => {
                        return {
                            type: DiffLineType.Removed,
                            oldLineNumber: change.fromA + offset + 1,
                            newLineNumber: undefined,
                            text,
                        };
                    }),
                    ...newLines.slice(change.fromB, change.toB).map((text, offset) => {
                        return {
                            type: DiffLineType.Added,
                            oldLineNumber: undefined,
                            newLineNumber: change.fromB + offset + 1,
                            text,
                        };
                    }),
                    ...contextLines({
                        oldLines,
                        fromOld: change.toA,
                        fromNew: change.toB,
                        length: (next?.fromA ?? last.toA + trailingLength) - change.toA,
                    }),
                ];
            }),
        ],
    };
}

/**
 * A file's diff as the hunks git would print: only the changed lines plus a few lines of context
 * around each, rather than the whole file with the changes tinted.
 */
export function toDiffHunks({
    oldContent,
    newContent,
}: Readonly<{
    oldContent: string;
    newContent: string;
}>): DiffHunk[] {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    return groupChanges(
        diffLines({
            aLines: oldLines,
            bLines: newLines,
        }),
    )
        .map((group) => {
            return toHunk({
                group,
                oldLines,
                newLines,
            });
        })
        .filter(check.isTruthy);
}
