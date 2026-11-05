export enum DiffLineType {
    Context = 'context',
    Added = 'added',
    Removed = 'removed',
}

type DiffHunkLine = {
    type: DiffLineType;
    /** Undefined on a line that exists only on the other side. */
    oldLineNumber: number | undefined;
    newLineNumber: number | undefined;
    text: string;
};

export const diffLinePrefixes: Record<DiffLineType, string> = {
    [DiffLineType.Context]: ' ',
    [DiffLineType.Added]: '+',
    [DiffLineType.Removed]: '-',
};

const shownDiffLineCount = 4;

/** The end of a thread's `@@`-headed diff hunk, numbered from its header. */
export function parseDiffHunkTail(diffHunk: string) {
    const [
        header = '',
        ...lines
    ] = diffHunk.split('\n');
    const startLines = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    return lines
        .filter((line) => !line.startsWith('\\'))
        .reduce<{
            lines: DiffHunkLine[];
            oldLineNumber: number;
            newLineNumber: number;
        }>(
            (result, line) => {
                const type = line.startsWith('+')
                    ? DiffLineType.Added
                    : line.startsWith('-')
                      ? DiffLineType.Removed
                      : DiffLineType.Context;
                return {
                    lines: [
                        ...result.lines,
                        {
                            type,
                            oldLineNumber:
                                type === DiffLineType.Added ? undefined : result.oldLineNumber,
                            newLineNumber:
                                type === DiffLineType.Removed ? undefined : result.newLineNumber,
                            text: line.slice(1),
                        },
                    ],
                    oldLineNumber: result.oldLineNumber + (type === DiffLineType.Added ? 0 : 1),
                    newLineNumber: result.newLineNumber + (type === DiffLineType.Removed ? 0 : 1),
                };
            },
            {
                lines: [],
                oldLineNumber: Number(startLines?.[1] || 1),
                newLineNumber: Number(startLines?.[2] || 1),
            },
        )
        .lines.slice(-shownDiffLineCount);
}
