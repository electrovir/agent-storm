import {GitHubReaction, type GitHubReactionGroup} from '@agent-storm/common';
import {getEnumValues} from '@augment-vir/common';

export const reactionEmoji: Readonly<Record<GitHubReaction, string>> = {
    [GitHubReaction.ThumbsUp]: '👍',
    [GitHubReaction.ThumbsDown]: '👎',
    [GitHubReaction.Laugh]: '😄',
    [GitHubReaction.Hooray]: '🎉',
    [GitHubReaction.Confused]: '😕',
    [GitHubReaction.Heart]: '❤️',
    [GitHubReaction.Rocket]: '🚀',
    [GitHubReaction.Eyes]: '👀',
};

/** Menu labels for the reaction picker, since the emoji alone is a small tap target. */
export const reactionNames: Readonly<Record<GitHubReaction, string>> = {
    [GitHubReaction.ThumbsUp]: 'thumbs up',
    [GitHubReaction.ThumbsDown]: 'thumbs down',
    [GitHubReaction.Laugh]: 'laugh',
    [GitHubReaction.Hooray]: 'hooray',
    [GitHubReaction.Confused]: 'confused',
    [GitHubReaction.Heart]: 'heart',
    [GitHubReaction.Rocket]: 'rocket',
    [GitHubReaction.Eyes]: 'eyes',
};

/** In declaration order, which is the order GitHub's own reaction picker uses. */
export const allReactions = getEnumValues(GitHubReaction);

/**
 * The hover text github.com shows on a reaction, such as "alice, bob, and 3 more reacted with
 * heart".
 */
export function describeReactors({reaction, count, reactors}: Readonly<GitHubReactionGroup>) {
    const hiddenCount = count - reactors.length;
    return [
        new Intl.ListFormat('en').format(
            hiddenCount > 0
                ? [
                      ...reactors,
                      `${hiddenCount} more`,
                  ]
                : reactors,
        ),
        'reacted with',
        reactionNames[reaction],
    ].join(' ');
}
