import {check} from '@augment-vir/assert';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraForm,
    ViraFormFieldType,
    ViraModal,
    viraThemeByKeys,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {savingIcon} from '../icons/saving-icon.js';

/**
 * A settings modal holding a single shell command. `value` seeds the edit each time the modal
 * opens, `saveRequested` carries the edited command, and the parent closes the modal itself once a
 * save lands.
 */
export const VirCommandSettingsModal = defineAppElement<{
    open: boolean;
    modalTitle: string;
    label: string;
    value: string;
    /**
     * Shown while `value` is empty, which is how a caller names what an empty command falls back
     * to.
     */
    placeholder: string;
    isSubmitting: boolean;
    errorMessage: string;
}>()({
    tagName: 'vir-command-settings-modal',
    state() {
        return {
            draft: undefined as string | undefined,
        };
    },
    events: {
        saveRequested: defineElementEvent<string>(),
        closeRequested: defineElementEvent<void>(),
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            width: min(520px, calc(100dvw - 48px));
            max-width: 100%;
            box-sizing: border-box;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        if (!inputs.open && state.draft != undefined) {
            updateState({
                draft: undefined,
            });
        }
        const value = state.draft ?? inputs.value;

        function requestSave() {
            if (inputs.isSubmitting) {
                return;
            }
            dispatch(
                new events.saveRequested({
                    detail: value,
                }),
            );
        }

        function requestClose() {
            dispatch(
                new events.closeRequested({
                    detail: undefined,
                }),
            );
        }

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: inputs.modalTitle,
            })}
                ${listen(ViraModal.events.modalClose, requestClose)}
            >
                <div class="body">
                    <${ViraForm.assign({
                        fields: {
                            command: {
                                type: ViraFormFieldType.Text,
                                label: inputs.label,
                                value,
                                placeholder: inputs.placeholder,
                                hasError: !!inputs.errorMessage,
                            },
                        },
                        isDisabled: inputs.isSubmitting,
                        showClearButtons: true,
                    })}
                        ${listen(ViraForm.events.valueChange, (event) => {
                            updateState({
                                draft: check.isString(event.detail.value) ? event.detail.value : '',
                            });
                        })}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                requestSave();
                            }
                        })}
                    ></${ViraForm}>
                    ${inputs.errorMessage
                        ? html`
                              <div class="error">${inputs.errorMessage}</div>
                          `
                        : nothing}
                    <div class="footer">
                        <${ViraButton.assign({
                            text: 'Cancel',
                            buttonEmphasis: ViraEmphasis.Subtle,
                            color: ViraColorVariant.Neutral,
                            isDisabled: inputs.isSubmitting,
                        })}
                            ${listen('click', () => {
                                if (inputs.isSubmitting) {
                                    return;
                                }
                                requestClose();
                            })}
                        ></${ViraButton}>
                        <${ViraButton.assign({
                            text: 'Save',
                            color: ViraColorVariant.Brand,
                            icon: inputs.isSubmitting ? savingIcon : undefined,
                            isDisabled: inputs.isSubmitting,
                        })}
                            ${listen('click', requestSave)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
