// cspell:words meslo menlo

import {
    gitDiffFileEndpoint,
    GitDiffSide,
    GitFileChange,
    type GitDiffFile,
    type GitDiffFileContents,
    type ReviewComment,
} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {type Extension, type Text} from '@codemirror/state';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen, onDomCreated} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraSize, viraThemeByKeys} from 'vira';
import {fetchApi} from '../../util/api-client.js';
import {loadSyntaxExtensions} from '../../util/diff-syntax.js';
import {toFileIconUrl} from '../../util/file-icon.js';
import {defineAppElement} from '../define-app-element.js';
import {type AddCommentRequest, type EditCommentRequest} from './diff-editor-comments.js';
import {
    remountChangedDiffEditor,
    syncDiffEditorComments,
    toDisplayedOldContent,
    type RenderedDiff,
} from './diff-editor.js';
import {chunkSelectionsAtPointer, type SelectedChunk} from './diff-selection.js';
import {imageDiffStyles, renderImageDiff} from './image-diff.js';
import {VirFileComments} from './vir-file-comments.element.js';

/** What a file's stage button does to a file on this side. */
export const stageActionLabels: Readonly<Record<GitDiffSide, string>> = {
    [GitDiffSide.Staged]: 'Unstage',
    [GitDiffSide.Unstaged]: 'Stage',
};

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
    file: GitDiffFile;
    /** The scrolling ancestor, which is what "near the screen" is measured against. */
    scrollRoot: Element;
    hideWhitespace: boolean;
    unified: boolean;
    collapseUnchanged: boolean;
    isDark: boolean;
    isMobile: boolean;
    /** This file's comments only. */
    reviewComments: ReadonlyArray<ReviewComment>;
    enableComments: boolean;
    /** 1-based line the open comment composer is writing about in this file. */
    commentingLine: number | undefined;
}>()({
    tagName: 'vir-diff-review-file',
    events: {
        /** The header was clicked: the pane opens this file in its own diff. */
        fileSelected: defineElementEvent<string>(),
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
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-shrink: 0;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        /*
         * Sticky so the file a hunk belongs to is still named after scrolling a few hundred lines
         * into it, which is the one thing a stacked review loses over a per-file pane.
         */
        .file-header {
            position: sticky;
            top: 0;
            z-index: 1;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 10px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background: ${viraThemeByKeys.grey['behind-fg'].body.background.value};
        }

        .file-open {
            display: flex;
            flex-grow: 1;
            align-items: center;
            gap: 8px;
            min-width: 0;
            padding: 2px 0;
            appearance: none;
            border: none;
            cursor: pointer;
            font: inherit;
            text-align: left;
            background: none;
            color: inherit;

            &:hover .file-path {
                color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }
        }

        .file-icon {
            flex-grow: 0;
            flex-shrink: 0;
            width: 16px;
            height: 16px;
        }

        .file-path {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;

            &[data-deleted] {
                text-decoration: line-through;
            }
        }

        .file-stats {
            flex-grow: 0;
            flex-shrink: 0;
            font-size: 11px;
            font-family: 'MesloLGS NF', Menlo, monospace;
        }

        .insertions {
            color: ${viraThemeByKeys.green.foreground.body.foreground.value};
        }

        .deletions {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
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

        ${imageDiffStyles}
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
        if (state.isNear && state.loadedFile !== file) {
            updateState({
                loadedFile: file,
            });
            void fetchApi(gitDiffFileEndpoint, HttpMethod.Post, {
                requestData: {
                    folder: inputs.folder,
                    path: file.path,
                    oldPath: file.oldPath ?? undefined,
                    side: inputs.side,
                    allowLarge: false,
                },
            }).then(
                (content) => {
                    if (state.loadedFile === file) {
                        updateState({
                            content,
                            loadError: undefined,
                        });
                    }
                },
                (error: unknown) => {
                    if (state.loadedFile === file) {
                        updateState({
                            loadError: extractErrorMessage(error),
                        });
                    }
                },
            );
        }

        if (state.isNear && state.syntaxPath !== inputs.file.path && !state.syntaxLoading) {
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
        if (content && !isText && state.rendered) {
            state.rendered.editor?.destroy();
            state.editorParent?.replaceChildren();
            updateState({
                rendered: undefined,
            });
        }
        if (state.editorParent && content && isText && state.syntaxPath === file.path) {
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

        function renderNote() {
            if (state.loadError && !content) {
                return html`
                    <div class="note error">${state.loadError}</div>
                `;
            } else if (!content || (isText && !state.rendered)) {
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
                    ${renderImageDiff({
                        content,
                    })}
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
            } else if (state.rendered?.chunks.length) {
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

        return html`
            <div class="file-header">
                <button
                    type="button"
                    class="file-open"
                    title=${`Open ${inputs.file.path}`}
                    ${listen('click', () => {
                        dispatch(
                            new events.fileSelected({
                                detail: inputs.file.path,
                            }),
                        );
                    })}
                >
                    <img class="file-icon" src=${toFileIconUrl(inputs.file.path)} alt="" />
                    <span
                        class="file-path"
                        ?data-deleted=${inputs.file.change === GitFileChange.Deleted}
                    >
                        ${inputs.file.path}
                    </span>
                    <span class="file-stats">
                        <span class="insertions">+${inputs.file.insertions}</span>
                        <span class="deletions">−${inputs.file.deletions}</span>
                    </span>
                </button>
                <${ViraButton.assign({
                    text: stageActionLabels[inputs.side],
                    buttonSize: ViraSize.Small,
                    color: ViraColorVariant.Neutral,
                })}
                    ${listen('click', () => {
                        dispatch(
                            new events.stageFile({
                                detail: inputs.file,
                            }),
                        );
                    })}
                ></${ViraButton}>
            </div>
            ${renderNote()}
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
        `;
    },
});
