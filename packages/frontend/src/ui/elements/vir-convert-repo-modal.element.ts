import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraModal, ViraSize} from 'vira';
import type {ConvertRepoConfirmRequest} from '../../util/add-repo.js';
import {viraButtonOverrides} from '../button-overrides.styles.js';

export const VirConvertRepoModal = defineElement<{
    request: ConvertRepoConfirmRequest | undefined;
}>()({
    tagName: 'vir-convert-repo-modal',
    events: {
        confirmed: defineElementEvent<void>(),
        cancelled: defineElementEvent<void>(),
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 420px;
            max-width: 640px;
            color: var(--fg);
            font-family: var(--font-body);
        }

        .lede {
            font-size: var(--font-size-sm);
            line-height: var(--line-height-sm);
            color: var(--fg-subtle);
            margin: 0;
        }

        .plan-title {
            font-size: var(--font-size-xs);
            font-weight: var(--font-weight-semibold);
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--fg-muted);
            margin: 4px 0 0;
        }

        .plan {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 12px 14px;
            border-radius: var(--radius-md);
            background: var(--bg-subtle);
            border: 1px solid var(--border-subtle);
            font-family: var(--font-mono);
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg);
            word-break: break-all;
        }

        .plan-item {
            display: flex;
            gap: 8px;
        }

        .plan-bullet {
            color: var(--fg-muted);
            flex-shrink: 0;
        }

        .footnote {
            font-size: var(--font-size-xs);
            line-height: var(--line-height-xs);
            color: var(--fg-muted);
            margin: 0;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            padding-top: 4px;
        }

        ${viraButtonOverrides}
    `,
    render({inputs, dispatch, events}) {
        const request = inputs.request;
        return html`
            <${ViraModal.assign({
                open: !!request,
                modalTitle: 'Convert to git worktree?',
            })}
                ${listen(ViraModal.events.modalClose, () => dispatch(new events.cancelled()))}
            >
                ${request
                    ? html`
                          <div class="body">
                              <p class="lede">
                                  This repository doesn't yet use git worktrees. Convert it to a
                                  worktree?
                              </p>
                              <span class="plan-title">agent-storm will</span>
                              <div class="plan">
                                  <div class="plan-item">
                                      <span class="plan-bullet">•</span>
                                      <span>move ${request.path}/.git → ${request.path}/.bare</span>
                                  </div>
                                  <div class="plan-item">
                                      <span class="plan-bullet">•</span>
                                      <span>create ${request.path}/.git pointing to .bare</span>
                                  </div>
                                  <div class="plan-item">
                                      <span class="plan-bullet">•</span>
                                      <span>
                                          move the "${request.currentBranch}" branch into
                                          ${request.path}/${request.branchFolderName}/
                                      </span>
                                  </div>
                              </div>
                              <p class="footnote">
                                  Existing tracked files will be re-checked-out inside the new
                                  worktree folder.
                              </p>
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      color: ViraColorVariant.Neutral,
                                      buttonSize: ViraSize.Medium,
                                  })}
                                      ${listen('click', () => dispatch(new events.cancelled()))}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: 'Convert',
                                      color: ViraColorVariant.Brand,
                                      buttonSize: ViraSize.Medium,
                                  })}
                                      ${listen('click', () => dispatch(new events.confirmed()))}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
