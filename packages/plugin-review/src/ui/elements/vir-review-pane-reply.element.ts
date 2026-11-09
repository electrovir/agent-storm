// cspell:words unresolve

import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LoaderAnimated24Icon,
    ViraButton,
    ViraColorVariant,
    ViraSize,
    ViraTextArea,
} from 'vira';
import {messageStyles} from './review-pane-styles.js';

const buttonLoaderIcon = createSizedIcon(LoaderAnimated24Icon, 14);

/** A review thread's reply box with its Resolve and Reply buttons. */
export const VirReviewPaneReply = defineAppElement<{
    draft: string;
    isSending: boolean;
    /** Some thread's reply is sending, which blocks sending this one too. */
    isAnySending: boolean;
    isResolved: boolean;
    canResolve: boolean;
    errorMessage: string | undefined;
}>()({
    tagName: 'vir-review-pane-reply',
    events: {
        draftChanged: defineElementEvent<string>(),
        /** Fires for ⌘↩ even when Reply is disabled. */
        replySubmitted: defineElementEvent<void>(),
        resolveToggled: defineElementEvent<void>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
        }

        ${messageStyles}

        ${ViraTextArea} {
            width: 100%;
            font-size: 14px;
        }

        .reply-actions {
            display: flex;
            gap: 8px;
        }
    `,
    render({inputs, dispatch, events}) {
        const isSendDisabled = !inputs.draft.trim() || inputs.isAnySending;
        return html`
            <${ViraTextArea.assign({
                value: inputs.draft,
                placeholder: 'Reply… (⌘↩ to send)',
                rows: 2,
                disabled: inputs.isSending,
            })}
                ${listen(ViraTextArea.events.valueChange, (event) => {
                    dispatch(
                        new events.draftChanged({
                            detail: event.detail,
                        }),
                    );
                })}
                ${listen('keydown', (event) => {
                    if (event.key !== 'Enter' || !event.metaKey) {
                        return;
                    }
                    event.preventDefault();
                    dispatch(
                        new events.replySubmitted({
                            detail: undefined,
                        }),
                    );
                })}
            ></${ViraTextArea}>
            ${inputs.errorMessage
                ? html`
                      <div class="message" data-error role="alert">${inputs.errorMessage}</div>
                  `
                : nothing}
            <div class="reply-actions">
                <${ViraButton.assign({
                    text: inputs.isResolved ? 'Unresolve' : 'Resolve',
                    buttonSize: ViraSize.Small,
                    color: ViraColorVariant.Neutral,
                    isDisabled: !inputs.canResolve,
                })}
                    ${listen('click', () => {
                        if (!inputs.canResolve) {
                            return;
                        }
                        dispatch(
                            new events.resolveToggled({
                                detail: undefined,
                            }),
                        );
                    })}
                ></${ViraButton}>
                <${ViraButton.assign({
                    text: 'Reply',
                    icon: inputs.isSending ? buttonLoaderIcon : undefined,
                    buttonSize: ViraSize.Small,
                    isDisabled: isSendDisabled,
                })}
                    ${listen('click', () => {
                        if (isSendDisabled) {
                            return;
                        }
                        dispatch(
                            new events.replySubmitted({
                                detail: undefined,
                            }),
                        );
                    })}
                ></${ViraButton}>
            </div>
        `;
    },
});
