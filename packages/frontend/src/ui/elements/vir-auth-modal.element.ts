import {css, defineElement, html, listen} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraInput,
    ViraInputType,
    ViraModal,
    viraThemeByKeys,
} from 'vira';
import {getStoredSecret, setStoredSecret, subscribeSecret} from '../../util/auth.js';
import {reportRenderError} from '../../util/client-error-log.js';

type AuthModalState = {
    open: boolean;
    pending: string;
    unsubscribe: (() => void) | undefined;
};

export const VirAuthModal = defineElement()({
    tagName: 'vir-auth-modal',
    options: {
        errorHandler: reportRenderError,
    },
    state(): AuthModalState {
        return {
            open: !getStoredSecret(),
            pending: '',
            unsubscribe: undefined,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            width: min(520px, calc(100vw - 48px));
            max-width: 100%;
            box-sizing: border-box;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .description {
            font-size: 13px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        ${ViraInput} {
            min-width: 0;
            width: 100%;
        }

        @media (max-width: 420px) {
            .body {
                width: calc(100vw - 32px);
            }

            .footer {
                justify-content: stretch;
            }

            ${ViraButton} {
                width: 100%;
            }
        }
    `,
    init({updateState}) {
        const unsubscribe = subscribeSecret((secret) => {
            updateState({
                open: !secret,
            });
        });
        updateState({
            unsubscribe,
        });
    },
    cleanup({state}) {
        state.unsubscribe?.();
    },
    render({state, updateState}) {
        const submit = () => {
            const trimmed = state.pending.trim();
            if (!trimmed) {
                return;
            }
            setStoredSecret(trimmed);
            updateState({
                pending: '',
            });
        };

        return html`
            <${ViraModal.assign({
                open: state.open,
                modalTitle: 'agent-storm auth',
                blockLightDismissal: true,
            })}>
                <div class="body">
                    <div class="description">
                        Paste the auth secret the server printed on startup. Delete
                        <code>.not-committed/auth-secret</code>
                        if you need to generate a new key.
                    </div>
                    <${ViraInput.assign({
                        value: state.pending,
                        type: ViraInputType.Password,
                        placeholder: 'auth secret',
                        showClearButton: true,
                    })}
                        ${listen(ViraInput.events.valueChange, (event) =>
                            updateState({
                                pending: event.detail,
                            }),
                        )}
                        ${listen('keydown', (event) => {
                            if (event instanceof KeyboardEvent && event.key === 'Enter') {
                                submit();
                            }
                        })}
                    ></${ViraInput}>
                    <div class="footer">
                        <${ViraButton.assign({
                            text: 'Submit',
                            color: ViraColorVariant.Brand,
                            isDisabled: !state.pending.trim(),
                        })}
                            ${listen('click', submit)}
                        ></${ViraButton}>
                    </div>
                </div>
            </${ViraModal}>
        `;
    },
});
