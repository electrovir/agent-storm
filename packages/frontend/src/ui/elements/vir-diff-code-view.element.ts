import {type GitDiffFileContents, type ReviewComment} from '@agent-storm/common';
import {type Text} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {asyncProp, css, defineElementEvent, html, listen, nothing, onDomCreated} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {defineAppElement} from '../define-app-element.js';
import {type AddCommentRequest, type EditCommentRequest} from './diff-editor-comments.js';
import {
    remountChangedDiffEditor,
    syncDiffEditorComments,
    toDisplayedOldContent,
    type RenderedDiff,
} from './diff-editor.js';
import {toRulerMarks, type RulerMark} from './diff-ruler.js';
import {chunkSelectionsAtPointer, type SelectedChunk} from './diff-selection.js';

/**
 * The diff pane's single-file diff: the editor plus its overview ruler. Stays mounted for the
 * pane's whole life, hidden rather than removed, because the editor and its scroll position live in
 * this element's state and a poll that changes nothing must not rebuild them.
 */
export const VirDiffCodeView = defineAppElement<{
    /** Identifies the open file across polls; a new key is a new file. */
    fileKey: string | undefined;
    path: string | undefined;
    /** Undefined while the file loads, which leaves the previous file's editor in place. */
    content: GitDiffFileContents | undefined;
    hideWhitespace: boolean;
    unified: boolean;
    collapseUnchanged: boolean;
    isDark: boolean;
    isMobile: boolean;
    enableComments: boolean;
    /** This file's comments only. */
    comments: ReadonlyArray<ReviewComment>;
    /** 1-based line the open comment composer is writing about in this file. */
    commentingLine: number | undefined;
    /** Off while a git write runs, which leaves right-click to the browser's own menu. */
    canStage: boolean;
    /**
     * The newest scroll the change arrows asked for. Each new `requestId` scrolls once, so the same
     * chunk can be jumped back to.
     */
    chunkScroll:
        | Readonly<{
              chunkIndex: number;
              requestId: number;
          }>
        | undefined;
}>()({
    tagName: 'vir-diff-code-view',
    events: {
        /** The pane owns the comment composer, so this only says where it should open. */
        addCommentRequested: defineElementEvent<
            AddCommentRequest & {
                path: string;
            }
        >(),
        editCommentRequested: defineElementEvent<EditCommentRequest>(),
        deleteCommentRequested: defineElementEvent<ReviewComment>(),
        /** A right-click landed on changed lines. The pane owns the stage menu. */
        hunkMenuRequested: defineElementEvent<{
            x: number;
            y: number;
            selections: ReadonlyArray<SelectedChunk>;
            oldText: Text;
            newText: Text;
        }>(),
        /** The editor was rebuilt or removed, and now shows this many chunks. */
        chunkCountChange: defineElementEvent<number>(),
        /** A ruler mark was clicked and the editor scrolled to its chunk. */
        chunkActivate: defineElementEvent<number>(),
    },
    state() {
        return {
            /**
             * Host element the editor mounts into. Captured via `onDomCreated` because CodeMirror
             * builds its own DOM imperatively and can't be expressed as a lit template.
             */
            editorParent: undefined as HTMLElement | undefined,
            /**
             * Exactly what the mounted editor is showing. The pane re-reads the open file every
             * couple of seconds, and comparing the real content is what keeps an unchanged poll
             * from tearing down the editor and throwing away the user's scroll position.
             */
            rendered: undefined as RenderedDiff | undefined,
            rulerMarks: [] as RulerMark[],
            /**
             * Grammar for the open path. The editor waits for this rather than mounting plain and
             * re-mounting when it lands, which would throw away scroll position on every file
             * open.
             */
            syntax: asyncProp({
                async updateCallback({path}: Readonly<{path: string}>) {
                    return await loadSyntaxExtensions(path).catch(() => []);
                },
            }),
            /** The `chunkScroll` request already scrolled to. */
            handledChunkScroll: undefined as number | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: row;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        /*
         * Sideways scrolling belongs to the code pane alone: the editor's own scroller takes it when
         * line wrapping is off, and this host clipping instead of scrolling is what keeps the toolbar,
         * the sidebar, and the ruler from sliding off with it.
         */
        .editor-host {
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
            overflow-x: hidden;
            overflow-y: auto;
        }

        /*
         * Overview ruler, the same idea as VS Code's: a full-height strip where every change in
         * the file gets a mark at its proportional position, so the shape of the diff is visible
         * without scrolling through it.
         */
        .ruler {
            position: relative;
            flex-grow: 0;
            flex-shrink: 0;
            width: 14px;
            border-left: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background: ${viraThemeByKeys.grey['behind-bg'].invisible.background.value};
        }

        .ruler-mark {
            position: absolute;
            left: 2px;
            right: 2px;
            border-radius: 1px;
            cursor: pointer;
            appearance: none;
            border: none;
            padding: 0;
        }

        .ruler-mark:hover {
            left: 0;
            right: 0;
        }
    `,
    cleanup({state}) {
        state.rendered?.editor?.destroy();
    },
    render({inputs, state, updateState, host, dispatch, events}) {
        const content = inputs.content;
        if (inputs.path) {
            state.syntax.update({
                path: inputs.path,
            });
        }

        /**
         * An image or a binary has no hunks, so the last text file's chunks would otherwise stay
         * armed: the jump buttons would scroll a hidden editor and the ruler would mark a file
         * nobody is looking at.
         */
        if (content && (content.isImage || content.tooLargeOrBinary) && state.rendered) {
            state.rendered.editor?.destroy();
            state.editorParent?.replaceChildren();
            updateState({
                rulerMarks: [],
                rendered: undefined,
            });
            dispatch(
                new events.chunkCountChange({
                    detail: 0,
                }),
            );
        }

        const path = inputs.path;
        if (
            state.editorParent &&
            content &&
            !content.tooLargeOrBinary &&
            !content.isImage &&
            inputs.fileKey &&
            path &&
            state.syntax.isResolved()
        ) {
            const previous = state.rendered;
            const rendered = remountChangedDiffEditor({
                parent: state.editorParent,
                root: host.shadowRoot,
                rendered: previous,
                display: {
                    fileKey: inputs.fileKey,
                    oldContent: toDisplayedOldContent({
                        content,
                        hideWhitespace: inputs.hideWhitespace,
                    }),
                    newContent: content.newContent,
                    unified: inputs.unified,
                    collapseUnchanged: inputs.collapseUnchanged,
                    isDark: inputs.isDark,
                    isMobile: inputs.isMobile,
                    syntaxExtensions: state.syntax.value,
                    enableComments: inputs.enableComments,
                },
                commentHandlers: {
                    onAddComment(request) {
                        dispatch(
                            new events.addCommentRequested({
                                detail: {
                                    ...request,
                                    path,
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
                onGeometryChange(view, chunks) {
                    updateState({
                        rulerMarks: toRulerMarks(view, chunks),
                    });
                },
            });
            const editor = rendered?.editor;
            if (rendered) {
                updateState({
                    rendered,
                    /** Mark positions come from the mounted editor, so they wait for it to exist. */
                    rulerMarks: editor ? toRulerMarks(editor.view, rendered.chunks) : [],
                });
                dispatch(
                    new events.chunkCountChange({
                        detail: rendered.chunks.length,
                    }),
                );
            }
            /**
             * A fresh mount starts at line 1, so a change 800 lines into a file opens onto
             * untouched context. Jump to the first chunk instead — the reason the file is in the
             * list is what the user came to see.
             *
             * Only on a new file, not on every rebuild: a poll that picks up an edit the user just
             * made in their own editor also rebuilds, and yanking them back to the top of the file
             * each time would fight them mid-review.
             */
            const firstChunk = rendered?.chunks[0];
            if (rendered && editor && firstChunk && previous?.fileKey !== rendered.fileKey) {
                editor.view.dispatch({
                    effects: EditorView.scrollIntoView(
                        Math.min(firstChunk.fromB, editor.view.state.doc.length),
                        {
                            y: 'start',
                            yMargin: 24,
                        },
                    ),
                });
            }
        }

        const commentsShown = syncDiffEditorComments({
            rendered: state.rendered,
            commentingLine: inputs.commentingLine,
            comments: inputs.comments,
        });
        if (commentsShown) {
            updateState({
                rendered: commentsShown,
            });
        }

        /** Scroll the editor so the given chunk sits at the top of the viewport. */
        function scrollToChunk(index: number) {
            const chunk = state.rendered?.chunks[index];
            const view = state.rendered?.editor?.view;
            if (!chunk || !view) {
                return false;
            }
            view.dispatch({
                effects: EditorView.scrollIntoView(Math.min(chunk.fromB, view.state.doc.length), {
                    y: 'start',
                    yMargin: 24,
                }),
            });
            return true;
        }

        if (inputs.chunkScroll && inputs.chunkScroll.requestId !== state.handledChunkScroll) {
            updateState({
                handledChunkScroll: inputs.chunkScroll.requestId,
            });
            scrollToChunk(inputs.chunkScroll.chunkIndex);
        }

        /**
         * Right-click staging, the way VS Code does it: select any amount of the diff, right-click,
         * and move exactly what the selection covers across the index at once — down to individual
         * added lines, per {@link chunkSelectionsAtPointer}.
         */
        function onContextMenu(event: MouseEvent) {
            const rendered = state.rendered;
            const view = rendered?.editor?.view;
            if (!rendered || !view || !inputs.canStage) {
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
                new events.hunkMenuRequested({
                    detail: {
                        x: event.clientX,
                        y: event.clientY,
                        selections,
                        oldText: rendered.oldText,
                        newText: rendered.newText,
                    },
                }),
            );
        }

        const rulerTemplate =
            state.rulerMarks.length && content && !content.tooLargeOrBinary && !content.isImage
                ? html`
                      <div class="ruler">
                          ${state.rulerMarks.map((mark, index) => {
                              return html`
                                  <button
                                      type="button"
                                      class="ruler-mark"
                                      title="Jump to change ${index + 1}"
                                      style=${css`
                                          top: ${mark.topPercent}%;
                                          height: ${mark.heightPercent}%;
                                          background: ${mark.color};
                                      `}
                                      ${listen('click', () => {
                                          if (scrollToChunk(index)) {
                                              dispatch(
                                                  new events.chunkActivate({
                                                      detail: index,
                                                  }),
                                              );
                                          }
                                      })}
                                  ></button>
                              `;
                          })}
                      </div>
                  `
                : nothing;

        return html`
            <div
                class="editor-host"
                ${listen('contextmenu', onContextMenu)}
                ${onDomCreated((element) => {
                    if (element instanceof HTMLElement && !state.editorParent) {
                        updateState({
                            editorParent: element,
                        });
                    }
                })}
            ></div>
            ${rulerTemplate}
        `;
    },
});
