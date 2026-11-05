import {
    gitHubCommentEndpoint,
    GitHubCommentTarget,
    gitHubReactionEndpoint,
    gitHubResolveThreadEndpoint,
    type GitHubComment,
    type GitHubReaction,
    type GitHubReviewThread,
} from '@agent-storm/common';
import {extractErrorMessage} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {fetchApi} from '../../util/api-client.js';
import {
    hasViewerReacted,
    type PendingReactions,
    type ReactionError,
} from './review-pane-reactions.js';

/** The conversation list's unsent and in-flight replies, resolves, and reactions. */
export function createConversationState() {
    return {
        /** Unsent reply text, by review thread id. */
        replyDrafts: {} as Partial<Record<string, string>>,
        sendingReplyThreadId: '',
        /** Resolve toggles the UI already shows but GitHub may not have yet, by review thread id. */
        pendingResolved: {} as Partial<Record<string, boolean>>,
        /** Resolve toggles run one at a time so a burst of clicks doesn't hit GitHub at once. */
        resolveQueue: Promise.resolve() as Promise<void>,
        queuedResolveCount: 0,
        /** A failed reply or resolve toggle, shown under the thread's reply box. */
        replyError: undefined as
            | {
                  threadId: string;
                  message: string;
              }
            | undefined,
        /** By comment id. */
        pendingReactions: {} as Partial<Record<string, PendingReactions>>,
        /** Reaction toggles run one at a time so a burst of clicks doesn't hit GitHub at once. */
        reactionQueue: Promise.resolve() as Promise<void>,
        queuedReactionCount: 0,
        reactionError: undefined as ReactionError | undefined,
    };
}

export type ConversationState = ReturnType<typeof createConversationState>;

/**
 * The conversation list's replies, resolves, and reactions. Each one that lands calls `refreshPr`
 * so the list shows GitHub's copy.
 */
export function createConversationActions({
    state,
    updateState,
    refreshPr,
}: Readonly<{
    state: Readonly<ConversationState>;
    updateState: (newState: Partial<ConversationState>) => void;
    refreshPr: () => Promise<void>;
}>) {
    function setPendingReaction({
        commentId,
        reaction,
        isAdded,
    }: Readonly<{
        commentId: string;
        reaction: GitHubReaction;
        isAdded: boolean | undefined;
    }>) {
        updateState({
            pendingReactions: {
                ...state.pendingReactions,
                [commentId]: {
                    ...state.pendingReactions[commentId],
                    [reaction]: isAdded,
                },
            },
        });
    }

    async function sendReaction({
        commentId,
        reaction,
        add,
    }: Readonly<{
        commentId: string;
        reaction: GitHubReaction;
        add: boolean;
    }>) {
        try {
            await fetchApi(gitHubReactionEndpoint, HttpMethod.Post, {
                requestData: {
                    subjectId: commentId,
                    reaction,
                    add,
                },
            });
        } catch (error) {
            if (state.pendingReactions[commentId]?.[reaction] === add) {
                setPendingReaction({
                    commentId,
                    reaction,
                    isAdded: undefined,
                });
            }
            updateState({
                reactionError: {
                    commentId,
                    message: extractErrorMessage(error),
                },
            });
        }
        updateState({
            queuedReactionCount: state.queuedReactionCount - 1,
        });
        if (state.queuedReactionCount) {
            return;
        }
        await refreshPr();
        /** A click that landed during the refresh still needs its own override. */
        if (!state.queuedReactionCount) {
            updateState({
                pendingReactions: {},
            });
        }
    }

    function toggleReaction(comment: Readonly<GitHubComment>, reaction: GitHubReaction) {
        const add = !hasViewerReacted({
            comment,
            reaction,
            pending: state.pendingReactions[comment.id],
        });
        setPendingReaction({
            commentId: comment.id,
            reaction,
            isAdded: add,
        });
        updateState({
            reactionError:
                state.reactionError?.commentId === comment.id ? undefined : state.reactionError,
            queuedReactionCount: state.queuedReactionCount + 1,
            reactionQueue: state.reactionQueue.then(async () => {
                await sendReaction({
                    commentId: comment.id,
                    reaction,
                    add,
                });
            }),
        });
    }

    async function sendReply(threadId: string) {
        const body = state.replyDrafts[threadId]?.trim();
        if (!body || state.sendingReplyThreadId) {
            return;
        }
        updateState({
            sendingReplyThreadId: threadId,
            replyError: undefined,
        });
        try {
            await fetchApi(gitHubCommentEndpoint, HttpMethod.Post, {
                requestData: {
                    target: GitHubCommentTarget.Thread,
                    subjectId: threadId,
                    body,
                },
            });
            updateState({
                replyDrafts: {
                    ...state.replyDrafts,
                    [threadId]: '',
                },
            });
            await refreshPr();
        } catch (error) {
            updateState({
                replyError: {
                    threadId,
                    message: extractErrorMessage(error),
                },
            });
        } finally {
            updateState({
                sendingReplyThreadId: '',
            });
        }
    }

    function isThreadResolved(thread: Readonly<GitHubReviewThread>) {
        return state.pendingResolved[thread.id] ?? thread.isResolved;
    }

    async function sendThreadResolved({
        threadId,
        resolved,
    }: Readonly<{
        threadId: string;
        resolved: boolean;
    }>) {
        try {
            await fetchApi(gitHubResolveThreadEndpoint, HttpMethod.Post, {
                requestData: {
                    threadId,
                    resolved,
                },
            });
        } catch (error) {
            if (state.pendingResolved[threadId] === resolved) {
                updateState({
                    pendingResolved: {
                        ...state.pendingResolved,
                        [threadId]: undefined,
                    },
                });
            }
            updateState({
                replyError: {
                    threadId,
                    message: extractErrorMessage(error),
                },
            });
        }
        updateState({
            queuedResolveCount: state.queuedResolveCount - 1,
        });
        if (state.queuedResolveCount) {
            return;
        }
        await refreshPr();
        /** A click that landed during the refresh still needs its own override. */
        if (!state.queuedResolveCount) {
            updateState({
                pendingResolved: {},
            });
        }
    }

    function toggleThreadResolved(thread: Readonly<GitHubReviewThread>) {
        const resolved = !isThreadResolved(thread);
        updateState({
            pendingResolved: {
                ...state.pendingResolved,
                [thread.id]: resolved,
            },
            replyError: state.replyError?.threadId === thread.id ? undefined : state.replyError,
            queuedResolveCount: state.queuedResolveCount + 1,
            resolveQueue: state.resolveQueue.then(async () => {
                await sendThreadResolved({
                    threadId: thread.id,
                    resolved,
                });
            }),
        });
    }

    return {
        toggleReaction,
        sendReply,
        isThreadResolved,
        toggleThreadResolved,
    };
}
