import {type GitDiffFile, type GitDiffSide, type ReviewComment} from '@agent-storm/common';
import {css, html, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {VirDiffReviewFile} from './vir-diff-review-file.element.js';

/**
 * Every changed file on one side, stacked in one scroll the way a pull request review reads, each
 * in the same diff editor the pane shows for a single file. The files' own events
 * ({@link VirDiffReviewFile}) bubble out of this element, so listen for them here.
 */
export const VirDiffReview = defineAppElement<{
    folder: string;
    side: GitDiffSide;
    files: ReadonlyArray<GitDiffFile>;
    hideWhitespace: boolean;
    unified: boolean;
    collapseUnchanged: boolean;
    isDark: boolean;
    isMobile: boolean;
    reviewComments: ReadonlyArray<ReviewComment>;
    enableComments: boolean;
    /** Where the open comment composer is writing, if anywhere. */
    commentDraft:
        | Readonly<{
              path: string;
              line: number;
          }>
        | undefined;
}>()({
    tagName: 'vir-diff-review',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow: auto;
        }

        .note {
            padding: 8px 10px;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    `,
    render({inputs, host}) {
        if (!inputs.files.length) {
            return html`
                <div class="note">Nothing to review on this side.</div>
            `;
        }
        /** Keyed by path so a file leaving the list can't hand its mounted editor to the next one. */
        return html`
            ${repeat(
                inputs.files,
                (file) => file.path,
                (file) => {
                    return html`
                        <${VirDiffReviewFile.assign({
                            folder: inputs.folder,
                            side: inputs.side,
                            file,
                            scrollRoot: host,
                            hideWhitespace: inputs.hideWhitespace,
                            unified: inputs.unified,
                            collapseUnchanged: inputs.collapseUnchanged,
                            isDark: inputs.isDark,
                            isMobile: inputs.isMobile,
                            enableComments: inputs.enableComments,
                            reviewComments: inputs.reviewComments.filter((comment) => {
                                return comment.path === file.path;
                            }),
                            commentingLine:
                                inputs.commentDraft?.path === file.path
                                    ? inputs.commentDraft.line
                                    : undefined,
                        })}></${VirDiffReviewFile}>
                    `;
                },
            )}
        `;
    },
});
