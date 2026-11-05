import {GitHubReviewState, type ReviewPr} from '@agent-storm/common';
import {css, html, nothing, unsafeCSS} from 'element-vir';
import {
    createSizedIcon,
    LucideCircleCheckIcon,
    LucideCircleXIcon,
    ViraIcon,
    viraThemeByKeys,
    type ViraIconSvg,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {commentHeaderStyles} from './review-pane-styles.js';
import {reviewStateLabels} from './review-pane-tags.js';

const reviewerStateIcons: Record<GitHubReviewState, ViraIconSvg | undefined> = {
    [GitHubReviewState.Approved]: createSizedIcon(LucideCircleCheckIcon, 28),
    [GitHubReviewState.ChangesRequested]: createSizedIcon(LucideCircleXIcon, 28),
    [GitHubReviewState.Commented]: undefined,
    [GitHubReviewState.Dismissed]: undefined,
    [GitHubReviewState.Pending]: undefined,
};

/** The PR's reviewers as avatars, each marked with its latest verdict. */
export const VirReviewPaneReviewers = defineAppElement<{
    reviewers: ReadonlyArray<Readonly<ReviewPr['reviewers'][number]>>;
}>()({
    tagName: 'vir-review-pane-reviewers',
    styles: css`
        :host {
            display: flex;
            gap: 4px;
            flex-shrink: 0;
            /* One avatar plus the gap and status icon below it. */
            min-height: calc(28px + 2px + 28px);
        }

        ${commentHeaderStyles}

        .reviewer {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;

            &[data-state='${unsafeCSS(GitHubReviewState.Approved)}'] {
                color: ${viraThemeByKeys.green.foreground.header.foreground.value};
            }

            &[data-state='${unsafeCSS(GitHubReviewState.ChangesRequested)}'] {
                color: ${viraThemeByKeys.red.foreground.header.foreground.value};
            }
        }

        .reviewer-avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
        }
    `,
    render({inputs}) {
        return inputs.reviewers.map((reviewer) => {
            const icon = reviewerStateIcons[reviewer.state];
            return html`
                <div
                    class="reviewer"
                    data-state=${reviewer.state}
                    title=${`${reviewer.login}: ${reviewStateLabels[reviewer.state]}`}
                >
                    ${reviewer.avatarUrl
                        ? html`
                              <img class="reviewer-avatar" src=${reviewer.avatarUrl} alt="" />
                          `
                        : html`
                              <span class="comment-author">${reviewer.login}</span>
                          `}
                    ${icon
                        ? html`
                              <${ViraIcon.assign({
                                  icon,
                              })}></${ViraIcon}>
                          `
                        : nothing}
                </div>
            `;
        });
    },
});
