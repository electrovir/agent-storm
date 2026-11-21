import {FontRole} from '@agent-storm/common';
import {defineAppElement, fontFamilyVar, fontSizeVar} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, nothing, onDomCreated} from 'element-vir';
import {
    popover,
    PopoverManager,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    ViraTextArea,
    viraShadows,
    viraThemeByKeys,
} from 'vira';
import {createPointPopoverStyles} from './point-popover-styles.js';

/** An open comment composer, placed in viewport coordinates beside the button that opened it. */
export type CommentDraft = Readonly<{
    x: number;
    y: number;
    path: string;
    line: number;
    /** Set when the composer edits this existing comment instead of adding one. */
    commentId: string | undefined;
    body: string;
    isSaving: boolean;
    error: string | undefined;
}>;

/**
 * The diff pane's floating review-comment editor. The pane holds the draft and does the save; this
 * reports typing and the save and cancel requests. It never sends `save` for an empty body or while
 * a save is running.
 */
export const VirDiffCommentComposer = defineAppElement<{
    draft: CommentDraft;
}>()({
    tagName: 'vir-diff-comment-composer',
    events: {
        bodyChange: defineElementEvent<string>(),
        save: defineElementEvent<undefined>(),
        cancel: defineElementEvent<undefined>(),
    },
    state() {
        return {
            popoverManager: new PopoverManager(),
        };
    },
    styles: css`
        ${createPointPopoverStyles(css`.comment-composer`)}

        .comment-composer {
            display: flex;
            flex-direction: column;
            gap: 6px;
            width: 360px;
            max-width: calc(100vw - 16px);
            box-sizing: border-box;
            padding: 8px;
            border-radius: 5px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            ${viraShadows.menuShadow}
            ${colorCss(viraThemeByKeys.grey['behind-fg'].body)};

            & ${ViraTextArea} {
                width: 100%;
                font-family: ${fontFamilyVar({
                    role: FontRole.Prompt,
                    fallback: 'inherit',
                })};
                font-size: ${fontSizeVar({
                    role: FontRole.Prompt,
                    fallback: 'inherit',
                })};
            }
        }

        .comment-composer-title {
            font-weight: 600;
        }

        .comment-composer-error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        .comment-composer-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
        }
    `,
    render({inputs, state, dispatch, events, host}) {
        const canSave = !inputs.draft.isSaving && !!inputs.draft.body.trim();

        function save() {
            if (canSave) {
                dispatch(
                    new events.save({
                        detail: undefined,
                    }),
                );
            }
        }

        function cancel() {
            dispatch(
                new events.cancel({
                    detail: undefined,
                }),
            );
        }

        return html`
            <span
                class="point-anchor"
                style=${css`
                    left: ${inputs.draft.x}px;
                    top: ${inputs.draft.y}px;
                `}
                ${popover(state.popoverManager, {
                    trigger: true,
                    getPopover() {
                        return assertWrap.instanceOf(
                            host.shadowRoot.querySelector('.comment-composer'),
                            HTMLElement,
                        );
                    },
                })}
            ></span>
            <div class="comment-composer" popover="manual">
                <div class="comment-composer-title">
                    ${inputs.draft.commentId ? 'Edit comment' : 'Comment'} on
                    ${inputs.draft.line ? `line ${inputs.draft.line}` : 'this file'}
                </div>
                <${ViraTextArea.assign({
                    value: inputs.draft.body,
                    placeholder: 'Markdown… (⌘↩ to save)',
                    rows: 4,
                    disabled: inputs.draft.isSaving,
                })}
                    ${onDomCreated((element) => {
                        requestAnimationFrame(() => {
                            element.shadowRoot?.querySelector('textarea')?.focus();
                        });
                    })}
                    ${listen(ViraTextArea.events.valueChange, (event) => {
                        dispatch(
                            new events.bodyChange({
                                detail: event.detail,
                            }),
                        );
                    })}
                    ${listen('keydown', (event) => {
                        if (event.key === 'Escape') {
                            cancel();
                        } else if (event.key === 'Enter' && event.metaKey) {
                            event.preventDefault();
                            save();
                        }
                    })}
                ></${ViraTextArea}>
                ${inputs.draft.error
                    ? html`
                          <div class="comment-composer-error" role="alert">
                              ${inputs.draft.error}
                          </div>
                      `
                    : nothing}
                <div class="comment-composer-actions">
                    <${ViraButton.assign({
                        text: 'Cancel',
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        ${listen('click', cancel)}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: inputs.draft.commentId ? 'Save' : 'Comment',
                        buttonSize: ViraSize.Small,
                        isDisabled: !canSave,
                    })}
                        ${listen('click', save)}
                    ></${ViraButton}>
                </div>
            </div>
        `;
    },
});
