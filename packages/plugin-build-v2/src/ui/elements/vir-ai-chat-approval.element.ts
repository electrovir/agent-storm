// cspell:words haspopup
import {defineAppElement} from '@agent-storm/core/frontend';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideGitBranchIcon,
    LucideShieldIcon,
    tooltip,
    ViraIcon,
    viraShadows,
    viraThemeByKeys,
} from 'vira';
import {ApprovalDecision, ApprovalKind, type ApprovalRequest} from '../../build-v2-api.js';
import {diffLineStyles, renderDiffLines} from './diff-lines.js';
import {approvalKindIcons} from './thread-display.js';

const approvalLabels: Record<
    ApprovalKind,
    Readonly<{
        label: string;
        detailLabel: string;
        /** What the user is asked, shown above the request's detail. */
        prompt: string;
    }>
> = {
    [ApprovalKind.Command]: {
        label: 'Command approval',
        detailLabel: 'Command',
        prompt: 'Allow the AI to run this command?',
    },
    [ApprovalKind.FileChange]: {
        label: 'File change approval',
        detailLabel: 'File change',
        prompt: 'Allow the AI to make this file change?',
    },
    [ApprovalKind.Permission]: {
        label: 'App permission approval',
        detailLabel: 'Permission request',
        prompt: 'Allow the AI to use this tool?',
    },
    [ApprovalKind.Question]: {
        label: 'Question',
        detailLabel: 'Question',
        prompt: 'The AI has a question.',
    },
};

const shieldIcon = createSizedIcon(LucideShieldIcon, 12);
const branchIcon = createSizedIcon(LucideGitBranchIcon, 12);

/** The request a thread waits on, shown as an inline row under the timeline. */
export const VirAiChatApproval = defineAppElement<{
    request: Readonly<ApprovalRequest>;
    /** How many requests wait, counting this one. */
    requestCount: number;
    /** While an answer to a request is being sent. */
    isBusy: boolean;
    /** Whether the thread can still move to a worktree, which it can only do once. */
    canMoveToWorktree: boolean;
}>()({
    tagName: 'vir-ai-chat-approval',
    events: {
        decided: defineElementEvent<ApprovalDecision>(),
        moveToWorktreeRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            isMoreOpen: false,
        };
    },
    styles: css`
        ${diffLineStyles}

        :host {
            display: block;
            font-size: 14px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .row {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 2px;
            min-width: 0;
        }

        .prompt {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding-left: 22px;
            overflow-wrap: anywhere;

            & .heading {
                font-weight: 500;
            }

            & .reason {
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                user-select: text;
            }
        }

        .detail-line {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            min-width: 0;
            user-select: none;

            & vira-icon {
                flex-shrink: 0;
                margin-top: 4px;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
                opacity: 0.7;
            }
        }

        code {
            display: block;
            flex-grow: 1;
            min-width: 0;
            max-height: 160px;
            overflow: auto;
            box-sizing: border-box;
            padding: 2px 4px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            overflow-wrap: anywhere;
            user-select: text;
            scrollbar-width: thin;

            /** Only the text keeps its whitespace, not the template's indentation around it. */
            & .detail-text {
                white-space: pre-wrap;
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }
        }

        .meta {
            display: flex;
            flex-direction: column;
            gap: 4px;
            padding-left: 22px;
            padding-bottom: 4px;
            font-size: 12px;
            min-width: 0;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            overflow-wrap: anywhere;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            column-gap: 8px;
            row-gap: 4px;
        }

        .waiting {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            color: ${viraThemeByKeys.yellow.foreground.header.foreground.value};
        }

        button.inline-button {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            padding: 0;
            border: none;
            background: none;
            font: inherit;
            font-weight: 500;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            cursor: pointer;
            text-underline-offset: 2px;

            &.primary {
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &:hover:not(:disabled) {
                text-decoration: underline;
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }

            &:disabled {
                cursor: default;
                opacity: 0.64;
            }
        }

        .more {
            position: relative;
            display: inline-flex;
        }

        .backdrop {
            position: fixed;
            inset: 0;
            z-index: 129;
        }

        .menu {
            position: absolute;
            bottom: 100%;
            right: 0;
            z-index: 130;
            margin-bottom: 4px;
            width: max-content;
            max-width: calc(100vw - 32px);
            padding: 4px;
            box-sizing: border-box;
            border-radius: 8px;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            ${viraShadows.menuShadow}

            & .menu-item {
                display: flex;
                align-items: center;
                min-height: 28px;
                padding: 4px 8px;
                border-radius: 6px;
                font-size: 13px;
                cursor: pointer;

                &:hover {
                    background-color: ${viraThemeByKeys.brand['behind-fg']['small-body'].background
                        .value};
                }
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const labels = approvalLabels[inputs.request.kind];
        const showsTitle =
            !!inputs.request.title &&
            !!inputs.request.detail &&
            inputs.request.detail !== inputs.request.title;
        const detail = inputs.request.detail || inputs.request.title || labels.label;

        function decide(decision: ApprovalDecision) {
            updateState({
                isMoreOpen: false,
            });
            if (inputs.isBusy) {
                return;
            }
            dispatch(
                new events.decided({
                    detail: decision,
                }),
            );
        }

        return html`
            <div
                class="row"
                role="group"
                data-v2-item-type="approval_request"
                aria-label=${labels.label}
            >
                <div class="prompt">
                    <span class="heading">${labels.prompt}</span>
                    ${inputs.request.reason
                        ? html`
                              <span class="reason">${inputs.request.reason}</span>
                          `
                        : nothing}
                </div>
                <div class="detail-line">
                    <${ViraIcon.assign({
                        icon: approvalKindIcons[inputs.request.kind],
                    })}></${ViraIcon}>
                    <code
                        class=${classMap({
                            'diff-block': inputs.request.kind === ApprovalKind.FileChange,
                        })}
                        data-approval-detail="complete"
                        aria-label=${labels.detailLabel}
                        tabindex="0"
                    >
                        ${inputs.request.kind === ApprovalKind.FileChange
                            ? renderDiffLines(detail)
                            : html`
                                  <span class="detail-text">${detail}</span>
                              `}
                    </code>
                </div>
                <div class="meta">
                    ${showsTitle
                        ? html`
                              <span>${inputs.request.title}</span>
                          `
                        : nothing}
                    <div class="actions">
                        <span class="waiting">
                            <${ViraIcon.assign({
                                icon: shieldIcon,
                            })}></${ViraIcon}>
                            Waiting for approval
                            ${inputs.requestCount > 1
                                ? html`
                                      <span>(1 of ${inputs.requestCount})</span>
                                  `
                                : nothing}
                        </span>
                        <span aria-hidden="true">·</span>
                        <button
                            type="button"
                            class="inline-button"
                            ?disabled=${inputs.isBusy}
                            ${listen('click', () => {
                                decide(ApprovalDecision.Decline);
                            })}
                        >
                            Decline
                        </button>
                        <button
                            type="button"
                            class="inline-button primary"
                            ?disabled=${inputs.isBusy}
                            ${listen('click', () => {
                                decide(ApprovalDecision.Approve);
                            })}
                        >
                            Approve
                        </button>
                        <span class="more">
                            <button
                                type="button"
                                class="inline-button"
                                aria-label="More approval options"
                                aria-haspopup="menu"
                                ?disabled=${inputs.isBusy}
                                ${listen('click', () => {
                                    updateState({
                                        isMoreOpen: !state.isMoreOpen,
                                    });
                                })}
                            >
                                More
                            </button>
                            ${state.isMoreOpen
                                ? html`
                                      <div
                                          class="backdrop"
                                          ${listen('click', () => {
                                              updateState({
                                                  isMoreOpen: false,
                                              });
                                          })}
                                      ></div>
                                      <div class="menu" role="menu">
                                          <div
                                              class="menu-item"
                                              role="menuitem"
                                              tabindex="-1"
                                              ${listen('click', () => {
                                                  decide(ApprovalDecision.ApproveForSession);
                                              })}
                                          >
                                              Always allow this session
                                          </div>
                                      </div>
                                  `
                                : nothing}
                        </span>
                        ${inputs.canMoveToWorktree
                            ? html`
                                  <button
                                      type="button"
                                      class="inline-button"
                                      ${tooltip('Decline, then redo this work in a new worktree')}
                                      ?disabled=${inputs.isBusy}
                                      ${listen('click', () => {
                                          if (inputs.isBusy) {
                                              return;
                                          }
                                          dispatch(
                                              new events.moveToWorktreeRequested({
                                                  detail: undefined,
                                              }),
                                          );
                                      })}
                                  >
                                      <${ViraIcon.assign({
                                          icon: branchIcon,
                                      })}></${ViraIcon}>
                                      Move to worktree
                                  </button>
                              `
                            : nothing}
                    </div>
                </div>
            </div>
        `;
    },
});
