import {createArray} from '@augment-vir/common';
import {type Terminal} from '@xterm/xterm';

/** A row's indent plus any list or message marker: the column its wrapped continuation starts at. */
const hangingIndentPattern = /^\s*(?:(?:[⏺❯•*+-]|\d+[.)])\s+)?/;
const listMarkerPattern = /^(?:[⏺❯•*+-]|\d+[.)])\s/;
const boxDrawingPattern = /[─-▟]/;

/**
 * Whether `nextRow` continues `previousRow` because the AI CLI word-wrapped it. Claude Code ends
 * every wrapped row with a real `\r\n` instead of letting the terminal wrap, so xterm can't mark
 * these rows as wrapped. A row was wrapped when the next row's first word wouldn't have fit on it
 * and the next row sits at the previous row's hanging indent.
 */
function isAiSoftWrap({
    previousRow,
    nextRow,
    columns,
}: Readonly<{
    previousRow: string;
    nextRow: string;
    columns: number;
}>) {
    const nextText = nextRow.trimStart();
    const firstWord = nextText.split(' ')[0] || '';
    return (
        !!firstWord &&
        !boxDrawingPattern.test(previousRow.at(-1) || '') &&
        !boxDrawingPattern.test(firstWord[0] || '') &&
        !listMarkerPattern.test(nextText) &&
        nextRow.length - nextText.length ===
            (hangingIndentPattern.exec(previousRow)?.[0].length ?? 0) &&
        previousRow.length + 1 + firstWord.length > columns
    );
}

/**
 * Same as `terminal.getSelection()` but rejoins rows the AI CLI word-wrapped (see `isAiSoftWrap`)
 * into one line. Returns `undefined` when nothing is selected.
 */
export function getAiSelectionText(terminal: Readonly<Terminal>) {
    const range = terminal.getSelectionPosition();
    if (!range) {
        return undefined;
    }
    /** Xterm's selection positions are 0-based despite its docs saying 1-based. */
    const rows = createArray(range.end.y - range.start.y + 1, (index) => {
        const lineIndex = range.start.y + index;
        const line = terminal.buffer.active.getLine(lineIndex);
        return {
            fullText: line?.translateToString(true) || '',
            selectedText:
                line?.translateToString(
                    true,
                    lineIndex === range.start.y ? range.start.x : 0,
                    lineIndex === range.end.y ? range.end.x : undefined,
                ) || '',
            isWrapped: !!line?.isWrapped,
        };
    });
    return rows
        .map((row, index) => {
            const previousRow = rows[index - 1];
            if (!previousRow || row.isWrapped) {
                return row.selectedText;
            }
            return isAiSoftWrap({
                previousRow: previousRow.fullText,
                nextRow: row.fullText,
                columns: terminal.cols,
            })
                ? ` ${row.selectedText.trimStart()}`
                : `\n${row.selectedText}`;
        })
        .join('');
}
