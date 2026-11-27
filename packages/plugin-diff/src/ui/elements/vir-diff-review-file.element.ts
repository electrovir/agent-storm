import {type GitDiffSide, type ReviewComment} from '@agent-storm/common';
import {createPluginApiClient, defineAppElement} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {type Extension, type Text} from '@codemirror/state';
import {css, defineElementEvent, html, listen, nothing, onDomCreated} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {diffApi, type GitDiffFile, type GitDiffFileContents} from '../../diff-api.js';
import {type RenderDiffCodeView} from '../../util/diff-code-view.js';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {type AddCommentRequest, type EditCommentRequest} from './diff-editor-comments.js';
import {
    remountChangedDiffEditor,
    syncDiffEditorComments,
    toDisplayedOldContent,
    type RenderedDiff,
} from './diff-editor.js';
import {
    chunkSelectionAtLine,
    chunkSelectionsAtPointer,
    type SelectedChunk,
} from './diff-selection.js';
import {VirDiffExplanation} from './vir-diff-explanation.element.js';
import {stageActionLabels, VirDiffFileHeader} from './vir-diff-file-header.element.js';
import {VirFileComments} from './vir-file-comments.element.js';
import {toSvgImageContent, VirImageDiff} from './vir-image-diff.element.js';

/** Pixel height of one editor line, for sizing a file before its editor exists. */
const estimatedLineHeight = 14;

/** Placeholder lines a file reserves past its changed ones, standing in for the context around them. */
const estimatedContextLines = 8;

/**
 * Cap on a placeholder's height, so a file rewritten end to end doesn't push every file after it
 * out past where the reader can scroll to before it loads.
 */
const maxPlaceholderHeight = 4000;

/**
 * One file of the stacked review: its header, then the same diff editor the pane shows for a single
 * file. Nothing is read or mounted until the file scrolls near `scrollRoot`, so opening a review of
 * a large change set costs only the files on screen.
 */
export const VirDiffReviewFile = defineAppElement<{
    folder: string;
    side: GitDiffSide;
    /** The status's `pullRequestBase`, which a pull request side's files are read against. */
    baseCommit: string | undefined;
    file: GitDiffFile;
    /** The scrolling ancestor, which is what "near the screen" is measured against. */
    scrollRoot: Element;
    /** Caps the explanation column so it scrolls itself rather than running past `scrollRoot`. */
    scrollRootHeight?: number | undefined;
    hideWhitespace: boolean;
    unified: boolean;
    collapseUnchanged: boolean;
    softWrap: boolean;
    isDark: boolean;
    isMobile: boolean;
    /** This file's comments only. */
    reviewComments: ReadonlyArray<ReviewComment>;
    enableComments: boolean;
    /** 1-based line the open comment composer is writing about in this file. */
    commentingLine: number | undefined;
    /** Draws the diff instead of the built-in CodeMirror view. */
    renderCodeView?: RenderDiffCodeView | undefined;
    /** Whether to show the explanation column, even for a file the skill wrote none for. */
    isExplanationShown?: boolean | undefined;
    explanation?: string | undefined;
}>()({
    tagName: 'vir-diff-review-file',
    events: {
        /** The stage button was clicked: the pane moves the whole file across the index. */
        stageFile: defineElementEvent<GitDiffFile>(),
        /** The pane owns the comment composer, so this only says where it should open. */
        addCommentRequested: defineElementEvent<
            AddCommentRequest & {
                path: string;
            }
        >(),
        editCommentRequested: defineElementEvent<EditCommentRequest>(),
        deleteCommentRequested: defineElementEvent<ReviewComment>(),
        /**
         * A right-click landed on changed lines. The pane owns the stage menu, so this carries
         * everything it needs to stage them: the chunks and the texts they were built from.
         */
        chunkMenuRequested: defineElementEvent<{
            x: number;
            y: number;
            file: GitDiffFile;
            selections: ReadonlyArray<SelectedChunk>;
            oldText: Text;
            newText: Text;
        }>(),
    },
    state() {
        return {
            observer: undefined as IntersectionObserver | undefined,
            /**
             * Whether the file is near the screen right now. Only a near file reads, but one that
             * has been read stays mounted after it scrolls away.
             */
            isNear: false,
            /**
             * The `file` input the newest read was started for. Every status poll hands over a new
             * object, so a near file re-reads on each poll: nothing in the status line reliably
             * changes with an edit, since an edit can keep both line counts and an untracked file's
             * are always zero.
             */
            loadedFile: undefined as GitDiffFile | undefined,
            /**
             * Whether a read is still running. A newer `file` waits for it, so polls on a busy
             * machine don't pile up reads, and the render after it lands starts the newest one.
             */
            isLoading: false,
            /**
             * Undefined until the first read lands. A re-read keeps showing the previous contents
             * until it does, so a poll that picked up an edit doesn't flash the file empty.
             */
            content: undefined as GitDiffFileContents | undefined,
            loadError: undefined as string | undefined,
            /** Resolved grammar for `syntaxPath`, which the editor waits for rather than remounting. */
            syntaxExtensions: [] as ReadonlyArray<Extension>,
            syntaxPath: undefined as string | undefined,
            syntaxLoading: false,
            editorParent: undefined as HTMLElement | undefined,
            rendered: undefined as RenderedDiff | undefined,
            /** What `renderCodeView` last reported, undefined until it has drawn. */
            codeViewChunkCount: undefined as number | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            flex-shrink: 0;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .file-main {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
        }

        /*
         * Sticks to the top of the review while its file scrolls past, the way the file header
         * does. Its max-height comes from the review's measured height, because a size container
         * on the review breaks its scrolling.
         */
        ${VirDiffExplanation}.beside {
            position: sticky;
            top: 0;
            align-self: flex-start;
        }

        /*
         * The editor's own theme fills its parent, which in a stack of files would be nothing:
         * here it grows to its content and the review around it does the scrolling. Isolated so
         * CodeMirror's sticky gutters can't stack over the sticky file header.
         */
        .editor {
            isolation: isolate;

            & .cm-editor {
                height: auto;
            }
        }

        .note {
            padding: 8px 10px;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }
    `,
    cleanup({state}) {
        state.observer?.disconnect();
        state.rendered?.editor?.destroy();
    },
    render({inputs, state, updateState, host, dispatch, events}) {
        if (!state.observer) {
            /**
             * Measured against the scrolling review rather than the viewport: the viewport's margin
             * never reaches past the review's clipped edges, so nothing below the fold would start
             * loading until it was already on screen.
             */
            const observer = new IntersectionObserver(
                (entries) => {
                    const latest = entries.at(-1);
                    if (latest) {
                        updateState({
                            isNear: latest.isIntersecting,
                        });
                    }
                },
                {
                    root: inputs.scrollRoot,
                    rootMargin: '1000px 0px',
                },
            );
            observer.observe(host);
            updateState({
                observer,
            });
        }

        const file = inputs.file;
        if (state.isNear && state.loadedFile !== file && !state.isLoading) {
            updateState({
                loadedFile: file,
                isLoading: true,
            });
            void createPluginApiClient(diffApi)
                .call('readFile', {
                    folder: inputs.folder,
                    path: file.path,
                    oldPath: file.oldPath ?? undefined,
                    side: inputs.side,
                    baseCommit: inputs.baseCommit,
                    allowLarge: false,
                })
                .then(
                    (content) => {
                        updateState({
                            content,
                            loadError: undefined,
                            isLoading: false,
                        });
                    },
                    (error: unknown) => {
                        updateState({
                            loadError: extractErrorMessage(error),
                            isLoading: false,
                        });
                    },
                );
        }

        if (
            !inputs.renderCodeView &&
            state.isNear &&
            state.syntaxPath !== inputs.file.path &&
            !state.syntaxLoading
        ) {
            const path = inputs.file.path;
            updateState({
                syntaxLoading: true,
            });
            void loadSyntaxExtensions(path)
                .catch(() => [])
                .then((syntaxExtensions) => {
                    updateState({
                        syntaxExtensions,
                        syntaxPath: path,
                        syntaxLoading: false,
                    });
                });
        }

        const content = state.content;
        const isText = !!content && !content.isImage && !content.tooLargeOrBinary;
        const svgImageContent = toSvgImageContent({
            path: file.path,
            content,
        });
        if (content && !isText && state.rendered) {
            state.rendered.editor?.destroy();
            state.editorParent?.replaceChildren();
            updateState({
                rendered: undefined,
            });
        }
        if (
            !inputs.renderCodeView &&
            state.editorParent &&
            content &&
            isText &&
            state.syntaxPath === file.path
        ) {
            const rendered = remountChangedDiffEditor({
                parent: state.editorParent,
                root: host.shadowRoot,
                rendered: state.rendered,
                display: {
                    fileKey: file.path,
                    oldContent: toDisplayedOldContent({
                        content,
                        hideWhitespace: inputs.hideWhitespace,
                    }),
                    newContent: content.newContent,
                    unified: inputs.unified,
                    collapseUnchanged: inputs.collapseUnchanged,
                    softWrap: inputs.softWrap,
                    isDark: inputs.isDark,
                    isMobile: inputs.isMobile,
                    syntaxExtensions: state.syntaxExtensions,
                    enableComments: inputs.enableComments,
                },
                skipEmptyDiff: true,
                commentHandlers: {
                    onAddComment(request) {
                        dispatch(
                            new events.addCommentRequested({
                                detail: {
                                    ...request,
                                    path: file.path,
                                },
                            }),
                        );
                    },
                    onEditComment(request) {
                        dispatch(
                            new events.editCommentRequested({
                                detail: request,
                            }),
                        );
                    },
                    onDeleteComment(comment) {
                        dispatch(
                            new events.deleteCommentRequested({
                                detail: comment,
                            }),
                        );
                    },
                },
            });
            if (rendered) {
                updateState({
                    rendered,
                });
            }
        }

        const commentsShown = syncDiffEditorComments({
            rendered: state.rendered,
            commentingLine: inputs.commentingLine,
            comments: inputs.reviewComments,
        });
        if (commentsShown) {
            updateState({
                rendered: commentsShown,
            });
        }

        /**
         * Re-dispatched as this element's own events, since those are what the pane listens for on
         * the stacked review.
         */
        function renderFileComments() {
            if (!inputs.enableComments) {
                return '';
            }
            return html`
                <${VirFileComments.assign({
                    path: inputs.file.path,
                    comments: inputs.reviewComments.filter((comment) => !comment.line),
                })}
                    ${listen(VirFileComments.events.addCommentRequested, (event) => {
                        dispatch(
                            new events.addCommentRequested({
                                detail: event.detail,
                            }),
                        );
                    })}
                    ${listen(VirFileComments.events.editCommentRequested, (event) => {
                        dispatch(
                            new events.editCommentRequested({
                                detail: event.detail,
                            }),
                        );
                    })}
                    ${listen(VirFileComments.events.deleteCommentRequested, (event) => {
                        dispatch(
                            new events.deleteCommentRequested({
                                detail: event.detail,
                            }),
                        );
                    })}
                ></${VirFileComments}>
            `;
        }

        const isDrawn = inputs.renderCodeView
            ? state.codeViewChunkCount != undefined
            : !!state.rendered;
        const drawnChunkCount = inputs.renderCodeView
            ? state.codeViewChunkCount
            : state.rendered?.chunks.length;

        function renderNote() {
            if (state.loadError && !content) {
                return html`
                    <div class="note error">${state.loadError}</div>
                `;
            } else if (!content || (isText && !isDrawn)) {
                return html`
                    <div
                        class="note"
                        style=${css`
                            min-height: ${Math.min(
                                maxPlaceholderHeight,
                                (inputs.file.insertions +
                                    inputs.file.deletions +
                                    estimatedContextLines) *
                                    estimatedLineHeight,
                            )}px;
                        `}
                    >
                        Loading…
                    </div>
                `;
            } else if (content.isImage) {
                return html`
                    ${renderFileComments()}
                    <${VirImageDiff.assign({
                        content,
                    })}></${VirImageDiff}>
                `;
            } else if (content.tooLargeOrBinary) {
                return html`
                    ${renderFileComments()}
                    <div class="note">
                        ${content.canShowAnyway
                            ? 'Too large to diff here — open the file to see it.'
                            : 'Binary file — no diff shown.'}
                    </div>
                `;
            } else if (drawnChunkCount) {
                return '';
            } else {
                return html`
                    <div class="note">
                        ${inputs.hideWhitespace && content.oldContent !== content.newContent
                            ? 'Only whitespace changed.'
                            : 'No line changes.'}
                    </div>
                `;
            }
        }

        function renderExplanation(placement: 'beside' | 'inline') {
            if (!inputs.isExplanationShown || (placement === 'inline') !== inputs.isMobile) {
                return nothing;
            }
            return html`
                <${VirDiffExplanation.assign({
                    explanation: inputs.explanation,
                })}
                    class=${placement}
                    style=${placement === 'beside' && inputs.scrollRootHeight
                        ? css`
                              max-height: ${inputs.scrollRootHeight}px;
                          `
                        : nothing}
                ></${VirDiffExplanation}>
            `;
        }

        return html`
            <div class="file-main">
                <${VirDiffFileHeader.assign({
                    file: inputs.file,
                    side: inputs.side,
                })}
                    ${listen(VirDiffFileHeader.events.stageFile, (event) => {
                        dispatch(
                            new events.stageFile({
                                detail: event.detail,
                            }),
                        );
                    })}
                ></${VirDiffFileHeader}>
                ${renderExplanation('inline')} ${renderNote()}
                ${inputs.renderCodeView && content && isText
                    ? inputs.renderCodeView({
                          fileKey: file.path,
                          path: file.path,
                          content,
                          hideWhitespace: inputs.hideWhitespace,
                          unified: inputs.unified,
                          collapseUnchanged: inputs.collapseUnchanged,
                          softWrap: inputs.softWrap,
                          isDark: inputs.isDark,
                          chunkScroll: undefined,
                          isHidden: false,
                          setChunkCount(chunkCount) {
                              updateState({
                                  codeViewChunkCount: chunkCount,
                              });
                          },
                          canStage: !!stageActionLabels[inputs.side],
                          requestHunkMenu({x, y, lineNumber, isRemovedLine}) {
                              const chunkSelection = chunkSelectionAtLine({
                                  oldContent: toDisplayedOldContent({
                                      content,
                                      hideWhitespace: inputs.hideWhitespace,
                                  }),
                                  newContent: content.newContent,
                                  lineNumber,
                                  isRemovedLine,
                              });
                              if (chunkSelection) {
                                  dispatch(
                                      new events.chunkMenuRequested({
                                          detail: {
                                              ...chunkSelection,
                                              x,
                                              y,
                                              file: inputs.file,
                                          },
                                      }),
                                  );
                              }
                          },
                      })
                    : html`
                          <div
                              class="editor"
                              ${listen('contextmenu', (event) => {
                                  const rendered = state.rendered;
                                  const view = rendered?.editor?.view;
                                  if (!rendered || !view) {
                                      return;
                                  }
                                  const selections = chunkSelectionsAtPointer({
                                      view,
                                      chunks: rendered.chunks,
                                      event,
                                  });
                                  if (!selections.length) {
                                      return;
                                  }
                                  event.preventDefault();
                                  dispatch(
                                      new events.chunkMenuRequested({
                                          detail: {
                                              x: event.clientX,
                                              y: event.clientY,
                                              file: inputs.file,
                                              selections,
                                              oldText: rendered.oldText,
                                              newText: rendered.newText,
                                          },
                                      }),
                                  );
                              })}
                              ${onDomCreated((element) => {
                                  if (element instanceof HTMLElement && !state.editorParent) {
                                      updateState({
                                          editorParent: element,
                                      });
                                  }
                              })}
                          ></div>
                      `}
                ${svgImageContent
                    ? html`
                          <${VirImageDiff.assign({
                              content: svgImageContent,
                          })}></${VirImageDiff}>
                      `
                    : nothing}
            </div>
            ${renderExplanation('beside')}
        `;
    },
});
