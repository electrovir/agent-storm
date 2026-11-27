const openingFencePattern = /^ {0,3}(`{3,}|~{3,})/;

/** Splits a line that ends in a fence of three or more into its text and that fence. */
function matchTrailingFence(line: string) {
    const trimmed = line.trimEnd();
    const fenceCharacter = trimmed.at(-1);
    if (fenceCharacter !== '`' && fenceCharacter !== '~') {
        return undefined;
    }
    const characters = Array.from(trimmed);
    const fenceLength =
        characters.length -
        characters.findLastIndex((character) => character !== fenceCharacter) -
        1;
    const leadingText = trimmed.slice(0, trimmed.length - fenceLength).trimEnd();
    return leadingText && fenceLength >= 3
        ? {
              leadingText,
              trailingFence: trimmed.slice(-fenceLength),
          }
        : undefined;
}

function isClosingFence({line, fence}: Readonly<{line: string; fence: string}>) {
    const trimmed = line.trim();
    return trimmed.length >= fence.length && trimmed === fence[0]?.repeat(trimmed.length);
}

/**
 * Moves a code fence typed at the end of a line of text onto its own line, so `Here: ```` opens a
 * code block like the writer meant instead of rendering literal backticks and turning the closing
 * fence into the opener. Only applies when the next fence line is a bare closing fence.
 */
export function splitTrailingFences(text: string) {
    const lines = text.split('\n');
    return lines
        .reduce<{lines: string[]; openFence: string | undefined}>(
            (state, line, index) => {
                if (state.openFence) {
                    return {
                        lines: [
                            ...state.lines,
                            line,
                        ],
                        openFence: isClosingFence({
                            line,
                            fence: state.openFence,
                        })
                            ? undefined
                            : state.openFence,
                    };
                }
                const openingFence = line.match(openingFencePattern)?.[1];
                if (openingFence) {
                    return {
                        lines: [
                            ...state.lines,
                            line,
                        ],
                        openFence: openingFence,
                    };
                }
                const {leadingText, trailingFence} = matchTrailingFence(line) || {};
                const isTrailingOpener =
                    !!leadingText &&
                    !!trailingFence &&
                    !leadingText.includes(trailingFence.slice(0, 3)) &&
                    isClosingFence({
                        /** A later fence line that isn't a bare closer opens a block of its own. */
                        line:
                            lines
                                .slice(index + 1)
                                .find((laterLine) => openingFencePattern.test(laterLine)) || '',
                        fence: trailingFence,
                    });
                return isTrailingOpener
                    ? {
                          lines: [
                              ...state.lines,
                              leadingText,
                              trailingFence,
                          ],
                          openFence: trailingFence,
                      }
                    : {
                          lines: [
                              ...state.lines,
                              line,
                          ],
                          openFence: undefined,
                      };
            },
            {
                lines: [],
                openFence: undefined,
            },
        )
        .lines.join('\n');
}
