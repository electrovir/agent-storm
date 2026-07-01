import {css, defineElement, html, listen} from 'element-vir';
import {
    lucideIcons,
    ViraButton,
    ViraColorVariant,
    ViraIcon,
    ViraInput,
    ViraInputType,
    ViraSize,
} from 'vira';
import {createWorktree} from '../../util/api-client.js';
import {router} from '../../util/router.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';

type AddWorktreeState = {
    name: string;
    busy: boolean;
    errorMessage: string | undefined;
};

export const VirAddWorktree = defineElement<{repoPath: string}>()({
    tagName: 'vir-add-worktree',
    state(): AddWorktreeState {
        return {
            name: '',
            busy: false,
            errorMessage: undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 16px;
            width: 100%;
            height: 100%;
            padding: 32px;
            color: var(--fg);
            font-family: var(--font-body);
            background: var(--bg);
            box-sizing: border-box;
        }

        .card {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: 16px;
            padding: 32px 36px;
            border-radius: var(--radius-panel-lg);
            background: var(--bg-panel);
            border: 1px solid var(--border);
            box-shadow: var(--shadow-md);
            max-width: 480px;
            width: 100%;
            box-sizing: border-box;
        }

        .close {
            position: absolute;
            top: 12px;
            right: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 28px;
            border-radius: var(--radius-md);
            background: transparent;
            border: 1px solid transparent;
            color: var(--fg-subtle);
            cursor: pointer;
            padding: 0;
        }

        .close:hover {
            color: var(--fg);
            background: var(--bg-subtle);
            border-color: var(--border-subtle);
        }

        .title {
            font-size: var(--font-size-xl);
            font-weight: var(--font-weight-semibold);
            color: var(--fg);
            letter-spacing: -0.01em;
            margin: 0;
        }

        .hint {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-subtle);
            margin: 0;
        }

        .repo {
            font-family: var(--font-mono);
            font-size: var(--font-size-xs);
            color: var(--fg-emphasized);
            background: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-sm);
            padding: 2px 8px;
            word-break: break-all;
        }

        .actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding-top: 4px;
        }

        .error {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-error);
            white-space: pre-wrap;
            padding: 8px 12px;
            border-radius: var(--radius-md);
            background: var(--bg-error);
            border: 1px solid var(--border-error);
        }

        ${viraButtonOverrides}
    `,
    render({inputs, state, updateState}) {
        const cancel = () => router.setRoute({paths: ['home']});

        const submit = async () => {
            const trimmed = state.name.trim();
            if (!trimmed || state.busy) {
                return;
            }
            updateState({
                busy: true,
                errorMessage: undefined,
            });
            try {
                await createWorktree({
                    repoPath: inputs.repoPath,
                    name: trimmed,
                });
                router.setRoute({paths: ['home']});
            } catch (error: unknown) {
                updateState({
                    busy: false,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
            }
        };

        return html`
            <div class="card">
                <button
                    class="close"
                    type="button"
                    title="Cancel"
                    aria-label="Cancel"
                    ${listen('click', cancel)}
                >
                    <${ViraIcon.assign({icon: lucideIcons.X})}></${ViraIcon}>
                </button>
                <span class="title">Name this worktree</span>
                <span class="hint">
                    Creating a new worktree under
                    <span class="repo">${inputs.repoPath}</span>
                </span>
                <${ViraInput.assign({
                    value: state.name,
                    type: ViraInputType.Default,
                    placeholder: 'worktree name',
                    showClearButton: true,
                })}
                    ${listen(ViraInput.events.valueChange, (event) =>
                        updateState({name: event.detail}),
                    )}
                    ${listen('keydown', (event) => {
                        if (event instanceof KeyboardEvent && event.key === 'Enter') {
                            void submit();
                        } else if (event instanceof KeyboardEvent && event.key === 'Escape') {
                            cancel();
                        }
                    })}
                ></${ViraInput}>
                ${state.errorMessage
                    ? html`
                          <span class="error">${state.errorMessage}</span>
                      `
                    : ''}
                <div class="actions">
                    <${ViraButton.assign({
                        text: 'Cancel',
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Neutral,
                    })}
                        ${listen('click', cancel)}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Create',
                        icon: lucideIcons.GitBranchPlus,
                        buttonSize: ViraSize.Medium,
                        color: ViraColorVariant.Brand,
                        isDisabled: !state.name.trim() || state.busy,
                    })}
                        ${listen('click', () => void submit())}
                    ></${ViraButton}>
                </div>
            </div>
        `;
    },
});
