// cspell:words meslo menlo

import {type ReviewQueuePr} from '@agent-storm/common';
import {wait} from '@augment-vir/common';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, nothing, unsafeHTML} from 'element-vir';
import {
    createSizedIcon,
    LucideCopyCheckIcon,
    LucideCopyIcon,
    LucideRotateCwIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraLink,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {defineAppElement} from '../define-app-element.js';
import {commentHeaderStyles} from './review-pane-styles.js';

const copyIcon = createSizedIcon(LucideCopyIcon, 14);
const copiedIcon = createSizedIcon(LucideCopyCheckIcon, 14);

/** The Review pane's PR author, title, branch, link, and refresh button. */
export const VirReviewPaneHeader = defineAppElement<{
    author: ReviewQueuePr['author'];
    authorAvatarUrl: ReviewQueuePr['authorAvatarUrl'];
    pullRequest: Readonly<Pick<ReviewQueuePr, 'title' | 'titleHtml' | 'url' | 'branchName'>>;
    isRefreshing: boolean;
}>()({
    tagName: 'vir-review-pane-header',
    events: {
        refreshRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            isUrlCopied: false,
        };
    },
    styles: css`
        :host {
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }

        ${commentHeaderStyles}

        .pr-author {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
            max-width: 80px;
            font-size: 11px;
            text-align: center;
            overflow-wrap: anywhere;
        }

        .pr-author-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
        }

        .heading {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex-grow: 1;
            min-width: 0;
        }

        /*
         * The whole button spins rather than just its icon: the icon lives inside ViraButton's own
         * shadow root.
         */
        .refresh-button[data-spinning] {
            animation: spin 900ms linear infinite;
        }

        @keyframes spin {
            to {
                transform: rotate(360deg);
            }
        }

        h2 {
            margin: 0;
            font-size: 1.1em;

            /* The title is one line of markdown, so only its inline code needs styling. */
            & code {
                padding: 1px 4px;
                border-radius: 4px;
                font-family: 'MesloLGS NF', Menlo, monospace;
                font-size: 0.85em;
                ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
            }
        }

        .branch-name {
            font-family: monospace;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            word-break: break-all;
        }

        .pr-url {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
            word-break: break-all;

            & ${ViraLink} {
                color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        return html`
            ${inputs.author
                ? html`
                      <div class="pr-author">
                          ${inputs.authorAvatarUrl
                              ? html`
                                    <img
                                        class="pr-author-avatar"
                                        src=${inputs.authorAvatarUrl}
                                        alt=""
                                    />
                                `
                              : nothing}
                          <span class="comment-author">${inputs.author}</span>
                      </div>
                  `
                : nothing}
            <div class="heading">
                <h2>
                    ${inputs.pullRequest.titleHtml
                        ? unsafeHTML(sanitizeGitHubHtml(inputs.pullRequest.titleHtml))
                        : inputs.pullRequest.title}
                </h2>
                <span class="branch-name">${inputs.pullRequest.branchName}</span>
                <div class="pr-url">
                    <${ViraLink.assign({
                        link: {
                            url: inputs.pullRequest.url,
                            newTab: true,
                        },
                    })}>
                        ${inputs.pullRequest.url}
                    </${ViraLink}>
                    <${ViraButton.assign({
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        icon: state.isUrlCopied ? copiedIcon : copyIcon,
                    })}
                        title="Copy the PR URL."
                        ${listen('click', async () => {
                            await navigator.clipboard.writeText(inputs.pullRequest.url);
                            updateState({
                                isUrlCopied: true,
                            });
                            await wait({
                                seconds: 2,
                            });
                            updateState({
                                isUrlCopied: false,
                            });
                        })}
                    ></${ViraButton}>
                </div>
            </div>
            <${ViraButton.assign({
                buttonSize: ViraSize.Small,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Neutral,
                icon: LucideRotateCwIcon,
                isDisabled: inputs.isRefreshing,
            })}
                class="refresh-button"
                ?data-spinning=${inputs.isRefreshing}
                title="Refresh the PR from GitHub."
                ${listen('click', () => {
                    if (inputs.isRefreshing) {
                        return;
                    }
                    dispatch(
                        new events.refreshRequested({
                            detail: undefined,
                        }),
                    );
                })}
            ></${ViraButton}>
        `;
    },
});
