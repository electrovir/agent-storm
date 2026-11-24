import {type ReviewComment} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {ViraCollapsibleCard, tooltip, viraThemeByKeys} from 'vira';

/** Every pending review comment in the folder, in a collapsible card that starts collapsed. */
export const VirDiffCommentList = defineAppElement<{
    comments: ReadonlyArray<ReviewComment>;
}>()({
    tagName: 'vir-diff-comment-list',
    events: {
        commentClick: defineElementEvent<ReviewComment>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-basis: 100%;
            min-width: 0;
        }

        ${ViraCollapsibleCard} {
            ${ViraCollapsibleCard.cssVars['vira-collapsible-card-content-gap'].name}: 0;
        }

        .header {
            padding: 2px 0;
            font-size: 10px;
            letter-spacing: 0.06em;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .comments {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding-top: 4px;
            font-size: 12px;
        }

        .comment {
            display: flex;
            flex-direction: column;
            padding: 4px;
            border: none;
            border-radius: 4px;
            background: none;
            color: inherit;
            font: inherit;
            text-align: start;
            cursor: pointer;

            &:hover {
                background: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            }
        }

        .location {
            max-width: 100%;
            font-family: monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .body {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
    `,
    render({inputs, dispatch, events}) {
        const sortedComments = inputs.comments.toSorted((first, second) => {
            return first.path.localeCompare(second.path) || first.line - second.line;
        });

        return html`
            <${ViraCollapsibleCard.assign({
                rawCollapsible: true,
                blockExpansion: !inputs.comments.length,
            })}>
                <div
                    class="header"
                    slot=${ViraCollapsibleCard.slotNames['vira-collapsible-card-header']}
                >
                    Comments (${inputs.comments.length})
                </div>
                <div class="comments">
                    ${sortedComments.map((comment) => {
                        return html`
                            <button
                                type="button"
                                class="comment"
                                ${listen('click', () => {
                                    dispatch(
                                        new events.commentClick({
                                            detail: comment,
                                        }),
                                    );
                                })}
                            >
                                <span class="location" ${tooltip(comment.path)}>
                                    ${comment.path.split('/').at(-1)}${comment.line
                                        ? `:${comment.line}`
                                        : ''}
                                </span>
                                <span class="body">${comment.body}</span>
                            </button>
                        `;
                    })}
                </div>
            </${ViraCollapsibleCard}>
        `;
    },
});
