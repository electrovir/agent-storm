// cspell:words meslo menlo

import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, nothing, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {diffLinePrefixes, DiffLineType, parseDiffHunkTail} from './diff-hunk-tail.js';

/** The last lines of a review thread's diff hunk, ending at the commented line. */
export const VirReviewPaneDiffHunk = defineAppElement<{
    diffHunk: string;
}>()({
    tagName: 'vir-review-pane-diff-hunk',
    styles: css`
        :host {
            display: block;
        }

        table {
            border-collapse: collapse;
            width: 100%;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;

            & tr[data-type='${unsafeCSS(DiffLineType.Added)}'] {
                background: ${viraThemeByKeys.green['behind-fg']['small-body'].background.value};
            }

            & tr[data-type='${unsafeCSS(DiffLineType.Removed)}'] {
                background: ${viraThemeByKeys.red['behind-fg']['small-body'].background.value};
            }

            & td {
                padding: 0 6px;
                overflow-wrap: anywhere;
                vertical-align: top;
            }

            & .code {
                white-space: pre-wrap;
            }

            & .line-number {
                width: 1px;
                text-align: right;
                white-space: nowrap;
                color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            }
        }
    `,
    render({inputs}) {
        return html`
            <table>
                ${parseDiffHunkTail(inputs.diffHunk).map((line) => {
                    return html`
                        <tr data-type=${line.type}>
                            <td class="line-number">${line.oldLineNumber ?? nothing}</td>
                            <td class="line-number">${line.newLineNumber ?? nothing}</td>
                            <td
                                class="code"
                                .textContent=${[
                                    diffLinePrefixes[line.type],
                                    line.text,
                                ].join('')}
                            ></td>
                        </tr>
                    `;
                })}
            </table>
        `;
    },
});
