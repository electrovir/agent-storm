import {defineAppElement} from '@agent-storm/core/frontend';
import {classMap, css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {ApprovalDecision, ApprovalKind, type ApprovalRequest} from '../../build-api.js';
import {diffLineStyles, renderDiffLines} from './diff-lines.js';
import {approvalKindIcons} from './thread-display.js';

const approvalLabels: Record<
    ApprovalKind,
    Readonly<{
        label: string;
        detailLabel: string;
        /** What the user is asked, shown as the card's header. */
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

/** The request a thread waits on, shown as a card under the timeline. */
export const VirAiChatApproval = defineAppElement<{
    request: Readonly<ApprovalRequest>;
    /** How many requests wait, counting this one. */
    requestCount: number;
    /** While an answer to a request is being sent. */
    isBusy: boolean;
}>()({
    tagName: 'vir-ai-chat-approval',
    events: {
        decided: defineElementEvent<ApprovalDecision>(),
    },
    styles: css`
        ${diffLineStyles}

        :host {
            display: block;
            font-size: 14px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        .card {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px;
            min-width: 0;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            border-left: 3px solid ${viraThemeByKeys.yellow.foreground.header.foreground.value};
            border-radius: 8px;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
        }

        .header {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            font-weight: 500;
            color: ${viraThemeByKeys.yellow.foreground.header.foreground.value};

            & .prompt {
                flex-grow: 1;
            }

            & .count {
                font-weight: normal;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        .summary {
            display: flex;
            flex-direction: column;
            gap: 2px;
            overflow-wrap: anywhere;
            user-select: text;

            & .title {
                font-size: 15px;
                font-weight: 600;
            }

            & .reason {
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        code {
            display: block;
            min-width: 0;
            max-height: 160px;
            overflow: auto;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            border-radius: 6px;
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
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

        .actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
        }
    `,
    render({inputs, dispatch, events}) {
        const labels = approvalLabels[inputs.request.kind];
        const showsTitle =
            !!inputs.request.title &&
            !!inputs.request.detail &&
            inputs.request.detail !== inputs.request.title;
        const detail = inputs.request.detail || inputs.request.title || labels.label;

        function decide(decision: ApprovalDecision) {
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
                class="card"
                role="group"
                data-v2-item-type="approval_request"
                aria-label=${labels.label}
            >
                <div class="header">
                    <${ViraIcon.assign({
                        icon: approvalKindIcons[inputs.request.kind],
                    })}></${ViraIcon}>
                    <span class="prompt">${labels.prompt}</span>
                    ${inputs.requestCount > 1
                        ? html`
                              <span class="count">1 of ${inputs.requestCount}</span>
                          `
                        : nothing}
                </div>
                ${showsTitle || inputs.request.reason
                    ? html`
                          <div class="summary">
                              ${showsTitle
                                  ? html`
                                        <span class="title">${inputs.request.title}</span>
                                    `
                                  : nothing}
                              ${inputs.request.reason
                                  ? html`
                                        <span class="reason">${inputs.request.reason}</span>
                                    `
                                  : nothing}
                          </div>
                      `
                    : nothing}
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
                <div class="actions">
                    <${ViraButton.assign({
                        text: 'Decline',
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Danger,
                        isDisabled: inputs.isBusy,
                    })}
                        ${listen('click', () => {
                            decide(ApprovalDecision.Decline);
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Always allow this session',
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Neutral,
                        isDisabled: inputs.isBusy,
                    })}
                        ${listen('click', () => {
                            decide(ApprovalDecision.ApproveForSession);
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Approve',
                        buttonSize: ViraSize.Small,
                        color: ViraColorVariant.Positive,
                        isDisabled: inputs.isBusy,
                    })}
                        ${listen('click', () => {
                            decide(ApprovalDecision.Approve);
                        })}
                    ></${ViraButton}>
                </div>
            </div>
        `;
    },
});
