import {GitHubReviewState, type GitHubReview} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, nothing, unsafeCSS, unsafeHTML} from 'element-vir';
import {ViraLink, viraThemeByKeys, ViraThemeColorName} from 'vira';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {relativeTime} from '../../util/relative-time.js';
import {commentHeaderStyles, markdownStyles} from './review-pane-styles.js';
import {renderTag, reviewStateLabels} from './review-pane-tags.js';
import {verdictReviewStates} from './review-sent-verdict.js';

const reviewStateTagColors: Record<GitHubReviewState, ViraThemeColorName> = {
    [GitHubReviewState.Approved]: ViraThemeColorName.green,
    [GitHubReviewState.ChangesRequested]: ViraThemeColorName.red,
    [GitHubReviewState.Commented]: ViraThemeColorName.blue,
    [GitHubReviewState.Dismissed]: ViraThemeColorName.grey,
    [GitHubReviewState.Pending]: ViraThemeColorName.yellow,
};

/** A submitted review in the Review pane's conversation list. */
export const VirReviewPaneReview = defineAppElement<{
    review: Readonly<GitHubReview>;
}>()({
    tagName: 'vir-review-pane-review',
    styles: css`
        :host {
            display: block;
        }

        ${commentHeaderStyles}
        ${markdownStyles}

        .review {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding: 8px;
            border-radius: 6px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            &[data-verdict] {
                padding: 0;
                border: none;

                & .review-bar::after {
                    content: '';
                    flex-grow: 1;
                    border-top: 2px solid;
                }

                & .comment-header {
                    padding: 2px 8px 2px 2px;
                    border-radius: 999px;
                    border: 2px solid;
                    background: white;
                }
            }

            &[data-verdict='${unsafeCSS(GitHubReviewState.ChangesRequested)}'] {
                & .review-bar::after,
                & .comment-header {
                    border-color: ${viraThemeByKeys.red.foreground.header.foreground.value};
                }
            }

            &[data-verdict='${unsafeCSS(GitHubReviewState.Approved)}'] {
                & .review-bar::after,
                & .comment-header {
                    border-color: ${viraThemeByKeys.green.foreground.header.foreground.value};
                }
            }
        }

        .review-bar {
            display: flex;
            align-items: center;
        }
    `,
    render({inputs}) {
        return html`
            <div
                class="review"
                data-verdict=${verdictReviewStates.includes(inputs.review.state)
                    ? inputs.review.state
                    : nothing}
            >
                <div class="review-bar">
                    <div class="comment-header">
                        ${inputs.review.authorAvatarUrl
                            ? html`
                                  <img class="avatar" src=${inputs.review.authorAvatarUrl} alt="" />
                              `
                            : nothing}
                        <span class="comment-author">${inputs.review.author}</span>
                        ${renderTag(
                            reviewStateLabels[inputs.review.state],
                            reviewStateTagColors[inputs.review.state],
                        )}
                        <${ViraLink.assign({
                            link: {
                                url: inputs.review.url,
                                newTab: true,
                            },
                        })}>
                            ${relativeTime(inputs.review.createdAt)}
                        </${ViraLink}>
                    </div>
                </div>
                ${inputs.review.bodyHtml
                    ? html`
                          <div class="markdown">
                              ${unsafeHTML(sanitizeGitHubHtml(inputs.review.bodyHtml))}
                          </div>
                      `
                    : nothing}
            </div>
        `;
    },
});
