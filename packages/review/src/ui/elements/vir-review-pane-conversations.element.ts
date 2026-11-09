import {
    type GitHubReviewThread,
    type ReviewPr,
    type ReviewQueuePr,
    type ReviewRequestEvent,
} from '@agent-storm/common';
import {
    defineAppElement,
    spinAnimationCss,
    spinKeyframesCss,
    type PrReviewsObservable,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {css, html, listen, nothing, repeat} from 'element-vir';
import {createSizedIcon, LucideLoaderIcon, ViraDropdown, ViraIcon} from 'vira';
import {relativeTime} from '../../util/relative-time.js';
import {ConversationSortOrder, reviewMemory} from '../../util/review-memory.js';
import {
    createConversationActions,
    createConversationState,
} from './review-pane-conversation-actions.js';
import {loadReviewPanePr} from './review-pane-load.js';
import {commentHeaderStyles, messageStyles} from './review-pane-styles.js';
import {VirReviewPaneComment} from './vir-review-pane-comment.element.js';
import {VirReviewPaneReply} from './vir-review-pane-reply.element.js';
import {VirReviewPaneReview} from './vir-review-pane-review.element.js';
import {VirReviewPaneThread} from './vir-review-pane-thread.element.js';

const loaderIcon = createSizedIcon(LucideLoaderIcon, 14);

/** Multiplies an oldest-first comparison. */
const conversationSortDirections: Record<ConversationSortOrder, number> = {
    [ConversationSortOrder.NewestFirst]: -1,
    [ConversationSortOrder.OldestFirst]: 1,
};

/**
 * The PR's review threads, reviews, and review requests in one sorted list. Owns every reply,
 * resolve, and reaction sent from it.
 */
export const VirReviewPaneConversations = defineAppElement<{
    pullRequest: Readonly<Pick<ReviewQueuePr, 'owner' | 'repoName' | 'number' | 'branchName'>>;
    /** Reloaded after each reply, resolve, or reaction. */
    prReviews: PrReviewsObservable;
    /** Undefined until the PR's first fetch lands. */
    prDetails: Readonly<ReviewPr> | undefined;
    loadError: string;
}>()({
    tagName: 'vir-review-pane-conversations',
    state() {
        return {
            ...createConversationState(),
            sortOrder: reviewMemory.conversationSortOrder.read(),
            removeSortOrderListener: undefined as (() => void) | undefined,
        };
    },
    init({updateState}) {
        updateState({
            removeSortOrderListener: reviewMemory.conversationSortOrder.subscribe((sortOrder) => {
                updateState({
                    sortOrder,
                });
            }),
        });
    },
    cleanup({state}) {
        state.removeSortOrderListener?.();
    },
    styles: css`
        :host {
            width: 1000px;
            max-width: 100%;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        ${commentHeaderStyles}
        ${messageStyles}
        ${spinKeyframesCss}

        .loading {
            display: flex;
            align-items: center;
            gap: 4px;

            & > ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        h3 {
            margin: 0;
            font-size: 14px;
        }

        .threads-header {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .review-request {
            padding: 0 8px;
        }
    `,
    render({inputs, state, updateState, host}) {
        const actions = createConversationActions({
            state,
            updateState,
            async refreshPr() {
                await loadReviewPanePr({
                    prReviews: inputs.prReviews,
                    pullRequest: inputs.pullRequest,
                    forceRefresh: true,
                });
            },
        });

        function renderThread(thread: Readonly<GitHubReviewThread>) {
            return html`
                <${VirReviewPaneThread.assign({
                    thread,
                    isResolved: actions.isThreadResolved(thread),
                    replyDraft: state.replyDrafts[thread.id] || '',
                    isSendingReply: state.sendingReplyThreadId === thread.id,
                    isAnyReplySending: !!state.sendingReplyThreadId,
                    replyError:
                        state.replyError?.threadId === thread.id
                            ? state.replyError.message
                            : undefined,
                    pendingReactions: state.pendingReactions,
                    reactionError: state.reactionError,
                })}
                    ${listen(VirReviewPaneThread.events.expandAllRequested, () => {
                        host.shadowRoot
                            .querySelectorAll(VirReviewPaneThread.tagName)
                            .forEach((threadElement) => {
                                threadElement.shadowRoot
                                    ?.querySelector('details')
                                    ?.setAttribute('open', '');
                            });
                    })}
                    ${listen(VirReviewPaneReply.events.draftChanged, (event) => {
                        updateState({
                            replyDrafts: {
                                ...state.replyDrafts,
                                [thread.id]: event.detail,
                            },
                        });
                    })}
                    ${listen(VirReviewPaneReply.events.replySubmitted, async () => {
                        await actions.sendReply(thread.id);
                    })}
                    ${listen(VirReviewPaneReply.events.resolveToggled, () => {
                        actions.toggleThreadResolved(thread);
                    })}
                    ${listen(VirReviewPaneComment.events.reactionToggled, (event) => {
                        actions.toggleReaction(event.detail.comment, event.detail.reaction);
                    })}
                ></${VirReviewPaneThread}>
            `;
        }

        function renderReviewRequest(request: Readonly<ReviewRequestEvent>) {
            return html`
                <div class="comment-header review-request">
                    ${request.requesterAvatarUrl
                        ? html`
                              <img class="avatar" src=${request.requesterAvatarUrl} alt="" />
                          `
                        : nothing}
                    <span class="comment-author">${request.requester || 'Someone'}</span>
                    ${request.isReRequest ? 're-requested your review' : 'requested your review'}
                    <span>${relativeTime(request.createdAt)}</span>
                </div>
            `;
        }

        const loadErrorTemplate = inputs.loadError
            ? html`
                  <div class="message" data-error role="alert">${inputs.loadError}</div>
              `
            : nothing;

        if (!inputs.prDetails) {
            return inputs.loadError
                ? loadErrorTemplate
                : html`
                      <div class="message loading">
                          <${ViraIcon.assign({
                              icon: loaderIcon,
                          })}></${ViraIcon}>
                          Loading comments…
                      </div>
                  `;
        }

        const sortOrder = state.sortOrder;
        /** GitHub's UTC ISO 8601 timestamps sort chronologically as plain strings. */
        const timeline = [
            ...inputs.prDetails.threads.map((thread) => {
                return {
                    id: thread.id,
                    createdAt: thread.comments[0]?.createdAt || '',
                    thread,
                };
            }),
            ...inputs.prDetails.reviews.map((review) => {
                return {
                    id: review.id,
                    createdAt: review.createdAt,
                    review,
                };
            }),
            ...inputs.prDetails.reviewRequests.map((request) => {
                return {
                    id: request.id,
                    createdAt: request.createdAt,
                    request,
                };
            }),
        ].toSorted((first, second) => {
            return (
                conversationSortDirections[sortOrder] *
                first.createdAt.localeCompare(second.createdAt)
            );
        });

        return html`
            <div class="threads-header">
                <h3>Previous Conversations (${timeline.length})</h3>
                <${ViraDropdown.assign({
                    options: [
                        {
                            value: ConversationSortOrder.NewestFirst,
                            label: 'Newest first',
                        },
                        {
                            value: ConversationSortOrder.OldestFirst,
                            label: 'Oldest first',
                        },
                    ],
                    selected: [
                        sortOrder,
                    ],
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        const picked = event.detail[0];
                        if (check.isEnumValue(picked, ConversationSortOrder)) {
                            reviewMemory.conversationSortOrder.write(picked);
                        }
                    })}
                ></${ViraDropdown}>
            </div>
            ${loadErrorTemplate}
            ${timeline.length
                ? repeat(
                      timeline,
                      (entry) => entry.id,
                      (entry) => {
                          if ('thread' in entry) {
                              return renderThread(entry.thread);
                          } else if ('review' in entry) {
                              return html`
                                  <${VirReviewPaneReview.assign({
                                      review: entry.review,
                                  })}></${VirReviewPaneReview}>
                              `;
                          } else {
                              return renderReviewRequest(entry.request);
                          }
                      },
                  )
                : html`
                      <div class="message">You haven't reviewed this PR yet.</div>
                  `}
        `;
    },
});
