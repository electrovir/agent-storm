import {diffLines} from './vscode-diff.js';

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
}>) {
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
