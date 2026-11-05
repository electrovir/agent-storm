import {type GitHubComment, type GitHubReaction} from '@agent-storm/common';
import {getObjectTypedEntries} from '@augment-vir/common';
import {allReactions} from '../../util/github-reactions.js';

/** Reaction toggles on one comment that the UI already shows but GitHub may not have yet. */
export type PendingReactions = Partial<Record<GitHubReaction, boolean>>;

/** A failed reaction toggle, shown under its comment. */
export type ReactionError = {
    commentId: string;
    message: string;
};

export function hasViewerReacted({
    comment,
    reaction,
    pending,
}: Readonly<{
    comment: Readonly<GitHubComment>;
    reaction: GitHubReaction;
    pending: Readonly<PendingReactions> | undefined;
}>) {
    return (
        pending?.[reaction] ??
        comment.reactions.some((group) => group.reaction === reaction && group.viewerHasReacted)
    );
}

/** The comment's reaction groups with queued toggles applied. */
export function getDisplayedReactions({
    comment,
    pending = {},
}: Readonly<{
    comment: Readonly<GitHubComment>;
    pending: Readonly<PendingReactions> | undefined;
}>) {
    const existingGroups = comment.reactions
        .map((group) => {
            const viewerHasReacted = pending[group.reaction] ?? group.viewerHasReacted;
            return {
                ...group,
                viewerHasReacted,
                count: group.count + Number(viewerHasReacted) - Number(group.viewerHasReacted),
            };
        })
        .filter((group) => group.count > 0);
    const addedGroups = getObjectTypedEntries(pending)
        .filter(
            ([
                reaction,
                isAdded,
            ]) => {
                return isAdded && !comment.reactions.some((group) => group.reaction === reaction);
            },
        )
        .map(([reaction]) => {
            return {
                reaction,
                count: 1,
                viewerHasReacted: true,
                reactors: [
                    'you',
                ],
            };
        });
    return [
        ...existingGroups,
        ...addedGroups,
    ].toSorted((first, second) => {
        return allReactions.indexOf(first.reaction) - allReactions.indexOf(second.reaction);
    });
}
