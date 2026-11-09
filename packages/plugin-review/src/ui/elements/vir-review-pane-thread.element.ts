// cspell:words meslo menlo

import {type GitHubReviewThread} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {ViraLink, viraThemeByKeys, ViraThemeColorName} from 'vira';
import {relativeTime} from '../../util/relative-time.js';
import {type PendingReactions, type ReactionError} from './review-pane-reactions.js';
import {commentHeaderStyles} from './review-pane-styles.js';
import {renderTag} from './review-pane-tags.js';
import {VirReviewPaneComment} from './vir-review-pane-comment.element.js';
import {VirReviewPaneDiffHunk} from './vir-review-pane-diff-hunk.element.js';
import {VirReviewPaneReply} from './vir-review-pane-reply.element.js';

/**
 * A collapsible review thread: its code, comments, and reply box. The reply box's and comments'
 * events bubble out of this element unchanged.
 */
export const VirReviewPaneThread = defineAppElement<{
    thread: Readonly<GitHubReviewThread>;
    isResolved: boolean;
    replyDraft: string;
    isSendingReply: boolean;
    isAnyReplySending: boolean;
    replyError: string | undefined;
    /** By comment id. */
    pendingReactions: Readonly<Partial<Record<string, PendingReactions>>>;
    reactionError: Readonly<ReactionError> | undefined;
}>()({
    tagName: 'vir-review-pane-thread',
    events: {
        /** The summary was alt-clicked, which opens every thread. */
        expandAllRequested: defineElementEvent<void>(),
    },
    styles: css`
        :host {
            display: block;
        }

        ${commentHeaderStyles}

        details {
            border-radius: 6px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            & > summary {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 8px;
                cursor: pointer;
                font-size: 12px;
            }

            &[open] > summary {
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            }
        }

        .thread-path {
            flex-shrink: 1;
            min-width: 0;
            overflow-wrap: anywhere;
            font-family: 'MesloLGS NF', Menlo, monospace;
            font-size: 11px;
        }

        .thread-time {
            flex-shrink: 0;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .thread-body {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
        }

        ${VirReviewPaneComment} + ${VirReviewPaneComment} {
            padding-top: 8px;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }
    `,
    render({inputs, dispatch, events}) {
        const starter = inputs.thread.comments[0];
        return html`
            <details ?open=${!inputs.isResolved}>
                <summary
                    ${listen('click', (event) => {
                        if (!event.altKey) {
                            return;
                        }
                        /** Keeps the native toggle from closing the clicked thread again. */
                        event.preventDefault();
                        dispatch(
                            new events.expandAllRequested({
                                detail: undefined,
                            }),
                        );
                    })}
                >
                    ${starter?.authorAvatarUrl
                        ? html`
                              <img class="avatar" src=${starter.authorAvatarUrl} alt="" />
                          `
                        : nothing}
                    ${starter
                        ? html`
                              <span class="comment-author">${starter.author}</span>
                          `
                        : nothing}
                    <span class="thread-path">
                        ${inputs.thread.path}${inputs.thread.line == undefined
                            ? nothing
                            : `:${inputs.thread.line}`}
                    </span>
                    ${inputs.thread.isOutdated
                        ? renderTag('Outdated', ViraThemeColorName.yellow)
                        : nothing}
                    ${inputs.isResolved ? renderTag('Resolved', ViraThemeColorName.green) : nothing}
                    ${starter
                        ? html`
                              <${ViraLink.assign({
                                  link: {
                                      url: starter.url,
                                      newTab: true,
                                  },
                              })}
                                  class="thread-time"
                              >
                                  ${relativeTime(starter.createdAt)}
                              </${ViraLink}>
                          `
                        : nothing}
                </summary>
                <div class="thread-body">
                    ${inputs.thread.diffHunk
                        ? html`
                              <${VirReviewPaneDiffHunk.assign({
                                  diffHunk: inputs.thread.diffHunk,
                              })}></${VirReviewPaneDiffHunk}>
                          `
                        : nothing}
                    ${inputs.thread.comments.map((comment) => {
                        return html`
                            <${VirReviewPaneComment.assign({
                                comment,
                                pendingReactions: inputs.pendingReactions[comment.id],
                                reactionError:
                                    inputs.reactionError?.commentId === comment.id
                                        ? inputs.reactionError.message
                                        : undefined,
                            })}></${VirReviewPaneComment}>
                        `;
                    })}
                    <${VirReviewPaneReply.assign({
                        draft: inputs.replyDraft,
                        isSending: inputs.isSendingReply,
                        isAnySending: inputs.isAnyReplySending,
                        isResolved: inputs.isResolved,
                        canResolve: inputs.thread.viewerCanResolve,
                        errorMessage: inputs.replyError,
                    })}></${VirReviewPaneReply}>
                </div>
            </details>
        `;
    },
});
