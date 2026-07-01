import {css, defineElement, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraInput, ViraInputType, ViraModal} from 'vira';
import {getStoredSecret, setStoredSecret, subscribeSecret} from '../../util/auth.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';

type AuthModalState = {
    open: boolean;
    pending: string;
    unsubscribe: (() => void) | undefined;
};

export const VirAuthModal = defineElement()({
    tagName: 'vir-auth-modal',
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
            gap: 16px;
            width: min(520px, calc(100vw - 48px));
            max-width: 100%;
            box-sizing: border-box;
            color: var(--fg);
            font-family: var(--font-body);
        }

        .description {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-subtle);
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .description p {
            margin: 0;
        }

        .description code {
            font-family: var(--font-mono);
            font-size: var(--font-size-xs);
            padding: 1px 6px;
            border-radius: var(--radius-sm);
            background: var(--bg-subtle);
            color: var(--fg-emphasized);
            border: 1px solid var(--border-subtle);
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding-top: 4px;
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

        ${viraButtonOverrides}
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
                        <p>
                            agent-storm runs a local server that can spawn shells, run AI agents,
                            and modify files in your repos. This shared secret prevents anything
                            other than you from talking to it.
                        </p>
                        <p>
                            Paste the secret printed in the server's startup log. It's stored in
                            this browser's <code>localStorage</code> and sent with every request as
                            a bearer token (and as the WebSocket subprotocol for terminals). Delete
                            <code>.not-committed/auth-secret</code> if you need to generate a new
                            key.
                        </p>
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
