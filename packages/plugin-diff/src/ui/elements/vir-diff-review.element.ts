import {type GitDiffSide, type ReviewComment} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {groupArrayBy} from '@augment-vir/common';
import {css, html, listen, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {type GitDiffFile} from '../../diff-api.js';
import {type RenderDiffCodeView} from '../../util/diff-code-view.js';
import {blurDiffEditorOnScroll} from './diff-editor.js';
import {probeScrollJumps} from './diff-scroll-probe.js';
import {VirDiffReviewFile} from './vir-diff-review-file.element.js';

/**
 * Every changed file on one side, stacked in one scroll the way a pull request review reads, each
 * in the same diff editor the pane shows for a single file. The files' own events
 * ({@link VirDiffReviewFile}) bubble out of this element, so listen for them here.
 */
export const VirDiffReview = defineAppElement<{
    folder: string;
    side: GitDiffSide;
    /** The status's `pullRequestBase`, which a pull request side's files are read against. */
    baseCommit: string | undefined;
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
    /** Draws each file's diff instead of the built-in CodeMirror view. */
    renderCodeView?: RenderDiffCodeView | undefined;
    /**
     * The manual-review skill's explanation of each file, keyed by path, shown beside it. Undefined
     * shows none.
     */
    fileExplanations?: Readonly<Record<string, string>> | undefined;
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
            /** This element's own height, which caps each file's explanation column. */
            height: undefined as number | undefined,
            resizeObserver: undefined as ResizeObserver | undefined,
        };
    },
    init({host, updateState}) {
        blurDiffEditorOnScroll(host);
        probeScrollJumps(host, 'review');
        const resizeObserver = new ResizeObserver((entries) => {
            const height = entries.at(-1)?.contentRect.height;
            if (height != undefined) {
                updateState({
                    height,
                });
            }
        });
        resizeObserver.observe(host);
        updateState({
            resizeObserver,
        });
    },
    cleanup({state}) {
        state.resizeObserver?.disconnect();
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
                /**
                 * Every render while the scroll is pending schedules one of these; the first one
                 * acts.
                 */
                if (state.pendingScroll !== pendingScroll) {
                    return;
                }
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
        /**
         * Quoted so a file named like an `Object.prototype` member, such as `constructor`, can't
         * collide with it in `groupArrayBy`'s plain object.
         */
        const commentsByPath = groupArrayBy(inputs.reviewComments, ({path}) => {
            return JSON.stringify(path);
        });
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
                            baseCommit: inputs.baseCommit,
                            file,
                            scrollRoot: host,
                            scrollRootHeight: state.height,
                            hideWhitespace: inputs.hideWhitespace,
                            unified: inputs.unified,
                            collapseUnchanged: inputs.collapseUnchanged,
                            softWrap: inputs.softWrap,
                            isDark: inputs.isDark,
                            isMobile: inputs.isMobile,
                            enableComments: inputs.enableComments,
                            reviewComments: commentsByPath[JSON.stringify(file.path)] || [],
                            commentingLine:
                                inputs.commentDraft?.path === file.path
                                    ? inputs.commentDraft.line
                                    : undefined,
                            renderCodeView: inputs.renderCodeView,
                            isExplanationShown: !!inputs.fileExplanations,
                            explanation: inputs.fileExplanations?.[file.path],
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
