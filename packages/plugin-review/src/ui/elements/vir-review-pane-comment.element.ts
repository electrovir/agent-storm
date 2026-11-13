import {type GitHubComment, type GitHubReaction} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing, unsafeHTML} from 'element-vir';
import {
    createSizedIcon,
    LoaderAnimated24Icon,
    LucideFaceSlightlySmilingPlusIcon,
    LucidePencilIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraLink,
    ViraMenuTrigger,
    ViraSize,
    ViraTextArea,
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

const buttonLoaderIcon = createSizedIcon(LoaderAnimated24Icon, 14);

/** One review thread comment with its reactions, editable in place when the viewer wrote it. */
export const VirReviewPaneComment = defineAppElement<{
    comment: Readonly<GitHubComment>;
    pendingReactions: Readonly<PendingReactions> | undefined;
    reactionError: string | undefined;
    /** The unsaved body while the comment is open for editing. */
    editDraft: string | undefined;
    isSavingEdit: boolean;
    /** Some comment's edit is saving, which blocks saving this one too. */
    isAnyEditSaving: boolean;
    editError: string | undefined;
}>()({
    tagName: 'vir-review-pane-comment',
    events: {
        reactionToggled: defineElementEvent<{
            comment: Readonly<GitHubComment>;
            reaction: GitHubReaction;
        }>(),
        /** A draft of undefined closes the editor. */
        editDraftChanged: defineElementEvent<{
            commentId: string;
            draft: string | undefined;
        }>(),
        /** The comment id. Fires for ⌘↩ even when Save is disabled. */
        editSubmitted: defineElementEvent<string>(),
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

        ${ViraTextArea} {
            width: 100%;
            font-size: 14px;
        }

        .edit-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
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

        function changeEditDraft(draft: string | undefined) {
            dispatch(
                new events.editDraftChanged({
                    detail: {
                        commentId: inputs.comment.id,
                        draft,
                    },
                }),
            );
        }

        function submitEdit() {
            dispatch(
                new events.editSubmitted({
                    detail: inputs.comment.id,
                }),
            );
        }

        const editDraft = inputs.editDraft;
        const isSaveDisabled = !editDraft?.trim() || inputs.isAnyEditSaving;
        const bodyTemplate =
            editDraft == undefined
                ? html`
                      <div class="markdown">
                          ${unsafeHTML(sanitizeGitHubHtml(inputs.comment.bodyHtml))}
                      </div>
                  `
                : html`
                      <${ViraTextArea.assign({
                          value: editDraft,
                          rows: 4,
                          disabled: inputs.isSavingEdit,
                      })}
                          ${listen(ViraTextArea.events.valueChange, (event) => {
                              changeEditDraft(event.detail);
                          })}
                          ${listen('keydown', (event) => {
                              if (event.key === 'Escape' && !inputs.isSavingEdit) {
                                  event.preventDefault();
                                  changeEditDraft(undefined);
                              } else if (event.key === 'Enter' && event.metaKey) {
                                  event.preventDefault();
                                  submitEdit();
                              }
                          })}
                      ></${ViraTextArea}>
                      ${inputs.editError
                          ? html`
                                <div class="message" data-error role="alert">
                                    ${inputs.editError}
                                </div>
                            `
                          : nothing}
                      <div class="edit-actions">
                          <${ViraButton.assign({
                              text: 'Cancel',
                              buttonSize: ViraSize.Small,
                              color: ViraColorVariant.Neutral,
                              isDisabled: inputs.isSavingEdit,
                          })}
                              ${listen('click', () => {
                                  if (inputs.isSavingEdit) {
                                      return;
                                  }
                                  changeEditDraft(undefined);
                              })}
                          ></${ViraButton}>
                          <${ViraButton.assign({
                              text: 'Save',
                              icon: inputs.isSavingEdit ? buttonLoaderIcon : undefined,
                              buttonSize: ViraSize.Small,
                              isDisabled: isSaveDisabled,
                          })}
                              ${listen('click', () => {
                                  if (isSaveDisabled) {
                                      return;
                                  }
                                  submitEdit();
                              })}
                          ></${ViraButton}>
                      </div>
                  `;

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
            ${bodyTemplate}
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
                ${inputs.comment.viewerCanEdit && editDraft == undefined
                    ? html`
                          <${ViraButton.assign({
                              icon: LucidePencilIcon,
                              buttonSize: ViraSize.Small,
                              buttonEmphasis: ViraEmphasis.Subtle,
                              color: ViraColorVariant.Neutral,
                          })}
                              ${tooltip('Edit comment')}
                              ${listen('click', () => {
                                  changeEditDraft(inputs.comment.body);
                              })}
                          ></${ViraButton}>
                      `
                    : nothing}
            </div>
            ${inputs.reactionError
                ? html`
                      <div class="message" data-error role="alert">${inputs.reactionError}</div>
                  `
                : nothing}
        `;
    },
});
