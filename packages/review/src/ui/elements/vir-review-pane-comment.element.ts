import {type GitHubComment, type GitHubReaction} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing, unsafeHTML} from 'element-vir';
import {
    LucideFaceSlightlySmilingPlusIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraLink,
    ViraMenuTrigger,
    ViraSize,
    ViraThemeColorName,
} from 'vira';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {
    allReactions,
    describeReactors,
    reactionEmoji,
    reactionNames,
} from '../../util/github-reactions.js';
import {relativeTime} from '../../util/relative-time.js';
import {getDisplayedReactions, type PendingReactions} from './review-pane-reactions.js';
import {commentHeaderStyles, markdownStyles, messageStyles} from './review-pane-styles.js';

/** One review thread comment with its reactions. */
export const VirReviewPaneComment = defineAppElement<{
    comment: Readonly<GitHubComment>;
    pendingReactions: Readonly<PendingReactions> | undefined;
    reactionError: string | undefined;
}>()({
    tagName: 'vir-review-pane-comment',
    events: {
        reactionToggled: defineElementEvent<{
            comment: Readonly<GitHubComment>;
            reaction: GitHubReaction;
        }>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        ${commentHeaderStyles}
        ${markdownStyles}
        ${messageStyles}

        .reactions {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
        }
    `,
    render({inputs, dispatch, events}) {
        function toggleReaction(reaction: GitHubReaction) {
            dispatch(
                new events.reactionToggled({
                    detail: {
                        comment: inputs.comment,
                        reaction,
                    },
                }),
            );
        }

        return html`
            <div class="comment-header">
                ${inputs.comment.authorAvatarUrl
                    ? html`
                          <img class="avatar" src=${inputs.comment.authorAvatarUrl} alt="" />
                      `
                    : nothing}
                <span class="comment-author">${inputs.comment.author}</span>
                <${ViraLink.assign({
                    link: {
                        url: inputs.comment.url,
                        newTab: true,
                    },
                })}>
                    ${relativeTime(inputs.comment.createdAt)}
                </${ViraLink}>
            </div>
            <div class="markdown">${unsafeHTML(sanitizeGitHubHtml(inputs.comment.bodyHtml))}</div>
            <div class="reactions">
                ${getDisplayedReactions({
                    comment: inputs.comment,
                    pending: inputs.pendingReactions,
                }).map((group) => {
                    return html`
                        <${ViraButton.assign({
                            text: `${reactionEmoji[group.reaction]} ${group.count}`,
                            buttonSize: ViraSize.Small,
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: group.viewerHasReacted
                                ? ViraThemeColorName.blue
                                : ViraColorVariant.Neutral,
                        })}
                            ${tooltip(describeReactors(group))}
                            ${listen('click', () => {
                                toggleReaction(group.reaction);
                            })}
                        ></${ViraButton}>
                    `;
                })}
                <${ViraMenuTrigger}>
                    <${ViraButton.assign({
                        icon: LucideFaceSlightlySmilingPlusIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        ${tooltip('Add reaction')}
                    ></${ViraButton}>
                    ${renderMenuItemEntries(
                        allReactions.map((reaction) => {
                            return {
                                content: `${reactionEmoji[reaction]} ${reactionNames[reaction]}`,
                                onClick() {
                                    toggleReaction(reaction);
                                },
                            };
                        }),
                    )}
                </${ViraMenuTrigger}>
            </div>
            ${inputs.reactionError
                ? html`
                      <div class="message" data-error role="alert">${inputs.reactionError}</div>
                  `
                : nothing}
        `;
    },
});
