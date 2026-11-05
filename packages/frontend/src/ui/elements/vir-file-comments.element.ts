import {type ReviewComment} from '@agent-storm/common';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    LucideMessageSquarePlusIcon,
    LucidePencilIcon,
    LucideTrashIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    createSizedIcon,
    viraThemeByKeys,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {type AddCommentRequest, type EditCommentRequest} from './diff-editor-comments.js';

const addCommentIcon = createSizedIcon(LucideMessageSquarePlusIcon, 12);
const editCommentIcon = createSizedIcon(LucidePencilIcon, 12);
const deleteCommentIcon = createSizedIcon(LucideTrashIcon, 12);

/**
 * Review comments on a whole file rather than a line, for files with no lines to put one beside:
 * images and binaries. They are stored with `line` set to `0`, which the manual-review skill posts
 * as a GitHub file-level thread, since GitHub shows no line diff for these files.
 */
export const VirFileComments = defineAppElement<{
    path: string;
    /** Whole-file comments on `path` only. */
    comments: ReadonlyArray<ReviewComment>;
}>()({
    tagName: 'vir-file-comments',
    events: {
        /** The pane owns the comment composer, so this only says where it should open. */
        addCommentRequested: defineElementEvent<
            AddCommentRequest & {
                path: string;
            }
        >(),
        editCommentRequested: defineElementEvent<EditCommentRequest>(),
        deleteCommentRequested: defineElementEvent<ReviewComment>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px 10px;
            font-size: 12px;
        }

        .comment {
            display: flex;
            align-items: flex-start;
            gap: 4px;
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
        }

        .comment-body {
            flex-grow: 1;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .add {
            align-self: flex-start;
        }
    `,
    render({inputs, dispatch, events}) {
        return html`
            ${inputs.comments.map((comment) => {
                return html`
                    <div class="comment">
                        <div class="comment-body">${comment.body}</div>
                        <${ViraButton.assign({
                            icon: editCommentIcon,
                            buttonSize: ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                        })}
                            title="Edit review comment"
                            ${listen('click', (event) => {
                                const anchor = extractEventTarget(
                                    event,
                                    HTMLElement,
                                ).getBoundingClientRect();
                                dispatch(
                                    new events.editCommentRequested({
                                        detail: {
                                            comment,
                                            anchor,
                                            lineBottom: anchor.bottom,
                                        },
                                    }),
                                );
                            })}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            icon: deleteCommentIcon,
                            buttonSize: ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Danger,
                        })}
                            title="Delete review comment"
                            ${listen('click', () => {
                                dispatch(
                                    new events.deleteCommentRequested({
                                        detail: comment,
                                    }),
                                );
                            })}
                        ></${ViraButton}>
                    </div>
                `;
            })}
            <${ViraButton.assign({
                text: 'Comment on file',
                icon: addCommentIcon,
                buttonSize: ViraSize.Small,
                color: ViraColorVariant.Neutral,
            })}
                class="add"
                ${listen('click', (event) => {
                    const anchor = extractEventTarget(event, HTMLElement).getBoundingClientRect();
                    dispatch(
                        new events.addCommentRequested({
                            detail: {
                                path: inputs.path,
                                lineNumber: 0,
                                anchor,
                                lineBottom: anchor.bottom,
                            },
                        }),
                    );
                })}
            ></${ViraButton}>
        `;
    },
});
