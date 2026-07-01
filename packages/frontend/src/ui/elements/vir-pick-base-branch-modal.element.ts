import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraModal, ViraSize} from 'vira';
import type {PickBaseBranchRequest} from '../../util/add-repo.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';

const preferredBaseBranchNames: ReadonlyArray<string> = [
    'main',
    'master',
    'dev',
    'develop',
];

function pickDefaultBranch(branches: ReadonlyArray<string>): string | undefined {
    for (const preferred of preferredBaseBranchNames) {
        if (branches.includes(preferred)) {
            return preferred;
        }
    }
    return branches[0];
}

type PickBaseBranchState = {
    selected: string | undefined;
    lastRequest: PickBaseBranchRequest | undefined;
};

export const VirPickBaseBranchModal = defineElement<{
    request: PickBaseBranchRequest | undefined;
}>()({
    tagName: 'vir-pick-base-branch-modal',
    state(): PickBaseBranchState {
        return {
            selected: undefined,
            lastRequest: undefined,
        };
    },
    events: {
        confirmed: defineElementEvent<string>(),
        cancelled: defineElementEvent<void>(),
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 420px;
            max-width: 560px;
            color: var(--fg);
            font-family: var(--font-body);
        }

        .lede {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-subtle);
            margin: 0;
        }

        .branch-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
            max-height: 320px;
            overflow: auto;
            padding: 4px;
            border-radius: var(--radius-md);
            background: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
        }

        .branch-option {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-radius: var(--radius-sm);
            font-family: var(--font-mono);
            font-size: var(--font-size-sm);
            color: var(--fg);
            background: transparent;
            border: 1px solid transparent;
            cursor: pointer;
            text-align: left;
            transition:
                background-color 120ms ease,
                border-color 120ms ease;
        }

        .branch-option:hover {
            background: color-mix(in srgb, var(--accent-solid) 8%, transparent);
        }

        .branch-option.active {
            border-color: var(--accent-solid);
            background: color-mix(in srgb, var(--accent-solid) 18%, transparent);
        }

        .radio {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            border: 1.5px solid var(--border);
            flex-shrink: 0;
            position: relative;
        }

        .branch-option.active .radio {
            border-color: var(--accent-solid);
        }

        .branch-option.active .radio::after {
            content: '';
            position: absolute;
            inset: 2px;
            border-radius: 50%;
            background: var(--accent-solid);
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding-top: 4px;
        }

        ${viraButtonOverrides}
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const request = inputs.request;
        // Seed the selection when a new request comes in.
        if (request && request !== state.lastRequest) {
            const defaulted = pickDefaultBranch(request.branches);
            updateState({selected: defaulted, lastRequest: request});
        } else if (!request && state.lastRequest) {
            updateState({selected: undefined, lastRequest: undefined});
        }

        const selected = state.selected;
        return html`
            <${ViraModal.assign({
                open: !!request,
                modalTitle: 'Pick the base branch',
            })}
                ${listen(ViraModal.events.modalClose, () => dispatch(new events.cancelled()))}
            >
                ${request
                    ? html`
                          <div class="body">
                              <p class="lede">
                                  Which existing worktree branch is the "main" / source-of-truth
                                  branch for this repo? It will be hidden from the sidebar and
                                  protected from deletion.
                              </p>
                              <div class="branch-list" role="radiogroup" aria-label="Base branch">
                                  ${request.branches.map(
                                      (branch) => html`
                                          <button
                                              type="button"
                                              role="radio"
                                              aria-checked=${selected === branch}
                                              class="branch-option ${selected === branch
                                                  ? 'active'
                                                  : ''}"
                                              ${listen('click', () =>
                                                  updateState({selected: branch}),
                                              )}
                                          >
                                              <span class="radio" aria-hidden="true"></span>
                                              <span>${branch}</span>
                                          </button>
                                      `,
                                  )}
                              </div>
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      color: ViraColorVariant.Neutral,
                                      buttonSize: ViraSize.Medium,
                                  })}
                                      ${listen('click', () => dispatch(new events.cancelled()))}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: 'Use as base branch',
                                      color: ViraColorVariant.Brand,
                                      buttonSize: ViraSize.Medium,
                                      isDisabled: !selected,
                                  })}
                                      ${listen('click', () => {
                                          if (selected) {
                                              dispatch(new events.confirmed(selected));
                                          }
                                      })}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
