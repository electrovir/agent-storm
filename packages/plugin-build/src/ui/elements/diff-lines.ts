import {css, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/** Styles for `renderDiffLines`'s output. */
export const diffLineStyles = css`
    .diff-block {
        white-space: normal;
    }

    .diff-line {
        display: block;
        min-height: 1em;
        white-space: pre-wrap;

        &[data-added] {
            color: ${viraThemeByKeys.green.foreground.body.foreground.value};
        }

        &[data-removed] {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        &[data-hunk] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }
    }
`;

/** The number of added and removed lines in a unified diff. */
export function countDiffLines(diff: string) {
    const lines = diff.split('\n');
    return {
        additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
    };
}

/**
 * A unified diff's lines, colored by whether each was added or removed. Put them in a `diff-block`
 * element: it stops the template's own line breaks between lines from showing.
 */
export function renderDiffLines(diff: string) {
    return diff.split('\n').map((line) => {
        /** Bound as text so formatting the template can't add whitespace to the line. */
        return html`
            <span
                class="diff-line"
                ?data-added=${line.startsWith('+') && !line.startsWith('+++')}
                ?data-removed=${line.startsWith('-') && !line.startsWith('---')}
                ?data-hunk=${line.startsWith('@@')}
                .textContent=${line}
            ></span>
        `;
    });
}
