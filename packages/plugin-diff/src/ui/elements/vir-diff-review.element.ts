import {type GitDiffSide, type ReviewComment} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, listen, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {type GitDiffFile} from '../../diff-api.js';
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
    softWrap: boolean;
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
    state() {
        return {
            /**
             * Set by a file's stage button: once the staged file leaves the list, the file after it
             * is scrolled to the top so the next thing to read is right there.
             */
            pendingScroll: undefined as
                | {
                      stagedPath: string;
                      nextPath: string;
                  }
                | undefined,
        };
    },
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
    render({inputs, state, updateState, host}) {
        const pendingScroll = state.pendingScroll;
        if (pendingScroll && !inputs.files.some((file) => file.path === pendingScroll.stagedPath)) {
            /** After this render commits, so the staged file's editor is already gone. */
            requestAnimationFrame(() => {
                updateState({
                    pendingScroll: undefined,
                });
                const nextFile = [
                    ...host.shadowRoot.querySelectorAll(VirDiffReviewFile.tagName),
                ].find((element) => {
                    return (
                        element instanceof HTMLElement &&
                        element.dataset.path === pendingScroll.nextPath
                    );
                });
                if (nextFile) {
                    host.scrollTop +=
                        nextFile.getBoundingClientRect().top - host.getBoundingClientRect().top;
                }
            });
        }
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
                (file, index) => {
                    const nextPath = inputs.files.at(index + 1)?.path;
                    return html`
                        <${VirDiffReviewFile.assign({
                            folder: inputs.folder,
                            side: inputs.side,
                            file,
                            scrollRoot: host,
                            hideWhitespace: inputs.hideWhitespace,
                            unified: inputs.unified,
                            collapseUnchanged: inputs.collapseUnchanged,
                            softWrap: inputs.softWrap,
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
                        })}
                            data-path=${file.path}
                            ${listen(VirDiffReviewFile.events.stageFile, () => {
                                updateState({
                                    pendingScroll: nextPath
                                        ? {
                                              stagedPath: file.path,
                                              nextPath,
                                          }
                                        : undefined,
                                });
                            })}
                        ></${VirDiffReviewFile}>
                    `;
                },
            )}
        `;
    },
});
