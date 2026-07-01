import {css, defineElement, html, listen} from 'element-vir';
import {lucideIcons, ViraButton, ViraColorVariant, ViraSize} from 'vira';
import {
    addRepoFlow,
    type ConvertRepoConfirmRequest,
    type PickBaseBranchRequest,
} from '../../util/add-repo.js';
import {router} from '../../util/router.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';
import {VirConvertRepoModal} from './vir-convert-repo-modal.element.js';
import {VirPickBaseBranchModal} from './vir-pick-base-branch-modal.element.js';

type AddRepoState = {
    errorMessage: string | undefined;
    busy: boolean;
    confirmRequest: ConvertRepoConfirmRequest | undefined;
    confirmResolve: ((confirmed: boolean) => void) | undefined;
    pickBranchRequest: PickBaseBranchRequest | undefined;
    pickBranchResolve: ((branch: string | undefined) => void) | undefined;
};

export const VirAddRepo = defineElement()({
    tagName: 'vir-add-repo',
    state(): AddRepoState {
        return {
            errorMessage: undefined,
            busy: false,
            confirmRequest: undefined,
            confirmResolve: undefined,
            pickBranchRequest: undefined,
            pickBranchResolve: undefined,
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
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
            padding: 32px 36px;
            border-radius: var(--radius-panel-lg);
            background: var(--bg-panel);
            border: 1px solid var(--border);
            box-shadow: var(--shadow-md);
            max-width: 420px;
            width: 100%;
            box-sizing: border-box;
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
            text-align: center;
            margin: 0;
        }

        .error {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-error);
            white-space: pre-wrap;
            text-align: center;
            padding: 8px 12px;
            border-radius: var(--radius-md);
            background: var(--bg-error);
            border: 1px solid var(--border-error);
        }

        ${viraButtonOverrides}
    `,
    render({state, updateState}) {
        const resolveConfirm = (confirmed: boolean) => {
            state.confirmResolve?.(confirmed);
            updateState({confirmRequest: undefined, confirmResolve: undefined});
        };

        const resolvePickBranch = (branch: string | undefined) => {
            state.pickBranchResolve?.(branch);
            updateState({pickBranchRequest: undefined, pickBranchResolve: undefined});
        };

        return html`
            <div class="card">
                <span class="title">Add a repo to get started</span>
                <span class="hint">Pick a folder on disk to register it with agent-storm.</span>
                <${ViraButton.assign({
                    text: 'Add repo',
                    icon: lucideIcons.Plus,
                    buttonSize: ViraSize.Medium,
                    color: ViraColorVariant.Brand,
                    isDisabled: state.busy,
                })}
                    ${listen('click', () => void addRepo(updateState))}
                ></${ViraButton}>
                ${state.errorMessage
                    ? html`
                          <span class="error">${state.errorMessage}</span>
                      `
                    : ''}
            </div>
            <${VirConvertRepoModal.assign({request: state.confirmRequest})}
                ${listen(VirConvertRepoModal.events.confirmed, () => resolveConfirm(true))}
                ${listen(VirConvertRepoModal.events.cancelled, () => resolveConfirm(false))}
            ></${VirConvertRepoModal}>
            <${VirPickBaseBranchModal.assign({request: state.pickBranchRequest})}
                ${listen(VirPickBaseBranchModal.events.confirmed, (event) =>
                    resolvePickBranch(event.detail),
                )}
                ${listen(VirPickBaseBranchModal.events.cancelled, () =>
                    resolvePickBranch(undefined),
                )}
            ></${VirPickBaseBranchModal}>
        `;
    },
});

async function addRepo(
    updateState: (newState: Partial<AddRepoState>) => void,
): Promise<void> {
    updateState({
busy: true, errorMessage: undefined
});
    try {
        const outcome = await addRepoFlow(
            (request) =>
                new Promise<boolean>((resolve) => {
                    updateState({confirmRequest: request, confirmResolve: resolve});
                }),
            (request) =>
                new Promise<string | undefined>((resolve) => {
                    updateState({pickBranchRequest: request, pickBranchResolve: resolve});
                }),
        );
        updateState({
busy: false
});
        if (outcome.kind !== 'cancelled') {
            router.setRoute({
paths: ['home']
});
        }
    } catch (error: unknown) {
        updateState({
            busy: false,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
    }
}
