import {type ReviewComment} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {type AddCommentRequest, type EditCommentRequest} from './diff-editor-comments.js';
import {type DiffPaneContext} from './diff-pane-controller.js';
import {deleteReviewComment, saveReviewComment} from './diff-pane-requests.js';

/** The review comment draft's lifecycle, and comment deletes, for `vir-diff-pane`. */
export function createDiffPaneComments({inputs, state, updateState}: DiffPaneContext) {
    /** Opens the composer beside the clicked button, kept inside the viewport. */
    function openCommentDraft({
        path,
        lineNumber,
        anchor,
        lineBottom,
        comment,
    }: Readonly<
        AddCommentRequest & {
            path: string;
            comment?: ReviewComment | undefined;
        }
    >) {
        updateState({
            commentDraft: {
                x: Math.max(8, Math.min(anchor.right + 4, window.innerWidth - 368)),
                y: Math.max(8, Math.min(lineBottom + 2, window.innerHeight - 220)),
                path,
                line: lineNumber,
                commentId: comment?.id,
                body: comment?.body || '',
                isSaving: false,
                error: undefined,
            },
        });
    }

    function openEditCommentDraft({comment, anchor, lineBottom}: Readonly<EditCommentRequest>) {
        openCommentDraft({
            path: comment.path,
            lineNumber: comment.line,
            anchor,
            lineBottom,
            comment,
        });
    }

    /**
     * Show the comment list a write returned, unless the pane moved to another folder while it ran.
     * A poll that read the list before the write would otherwise land after it and put the old list
     * back, so every read already started is marked outdated.
     *
     * @returns Whether the list was shown.
     */
    function showWrittenComments({
        folder,
        reviewComments,
    }: Readonly<{
        folder: string;
        reviewComments: ReadonlyArray<ReviewComment>;
    }>) {
        if (state.armedFolder !== folder) {
            return false;
        }
        updateState({
            reviewComments,
            firstCurrentRead: state.readsStarted + 1,
        });
        return true;
    }

    function closeCommentDraft() {
        updateState({
            commentDraft: undefined,
        });
    }

    async function saveCommentDraft() {
        const draft = state.commentDraft;
        const folder = inputs.folder;
        if (!draft || draft.isSaving || !draft.body.trim()) {
            return;
        }
        updateState({
            commentDraft: {
                ...draft,
                isSaving: true,
                error: undefined,
            },
        });
        try {
            const isShown = showWrittenComments({
                folder,
                reviewComments: await saveReviewComment({
                    folder,
                    draft,
                }),
            });
            if (isShown) {
                closeCommentDraft();
            }
        } catch (error) {
            if (state.armedFolder === folder) {
                updateState({
                    commentDraft: {
                        ...draft,
                        isSaving: false,
                        error: extractErrorMessage(error),
                    },
                });
            }
        }
    }

    async function onDeleteComment(comment: Readonly<ReviewComment>) {
        if (!window.confirm('Delete this review comment?')) {
            return;
        }
        const folder = inputs.folder;
        try {
            showWrittenComments({
                folder,
                reviewComments: await deleteReviewComment({
                    folder,
                    id: comment.id,
                }),
            });
        } catch (error) {
            window.alert(extractErrorMessage(error));
        }
    }

    function setCommentBody(body: string) {
        if (state.commentDraft) {
            updateState({
                commentDraft: {
                    ...state.commentDraft,
                    body,
                },
            });
        }
    }

    return {
        openCommentDraft,
        openEditCommentDraft,
        closeCommentDraft,
        saveCommentDraft,
        onDeleteComment,
        setCommentBody,
    };
}
