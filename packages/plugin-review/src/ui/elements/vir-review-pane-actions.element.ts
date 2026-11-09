import {ManualReviewStatus, type ManualReviewState} from '@agent-storm/common';
import {defineAppElement} from '@agent-storm/core/frontend';
import {type PartialWithUndefined} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {tooltip, ViraButton, ViraColorVariant, ViraEmphasis, ViraSize, viraThemeByKeys} from 'vira';
import {canPostVerdictByStatus} from '../../util/pane-review.js';

/** A Review pane button that sends the AI a prompt. */
export enum ReviewPaneAction {
    Start = 'start',
    Reset = 'reset',
    Abort = 'abort',
    Approve = 'approve',
    RequestChanges = 'request-changes',
}

const statusLabels: Record<ManualReviewStatus, string> = {
    [ManualReviewStatus.Started]: 'In review',
    [ManualReviewStatus.Approved]: 'Approved',
    [ManualReviewStatus.RequestedChanges]: 'Changes requested',
    [ManualReviewStatus.Commented]: 'Commented',
    [ManualReviewStatus.PostFailed]: 'Posting the review failed',
    [ManualReviewStatus.Aborted]: 'Aborted',
};

const pendingStatusLabels: Record<ManualReviewStatus, string> = {
    [ManualReviewStatus.Started]: 'Starting the review…',
    [ManualReviewStatus.Approved]: 'Approving…',
    [ManualReviewStatus.RequestedChanges]: 'Requesting changes…',
    [ManualReviewStatus.Commented]: 'Commenting…',
    [ManualReviewStatus.PostFailed]: 'Posting the review failed',
    [ManualReviewStatus.Aborted]: 'Aborting…',
};

/** The manual review's status and the buttons that start, reset, abort, or finish it. */
export const VirReviewPaneActions = defineAppElement<{
    /** Undefined when the skill has never recorded a review of the PR's branch. */
    review: Readonly<ManualReviewState> | undefined;
    /** Disables every button. */
    isLocked: boolean;
}>()({
    tagName: 'vir-review-pane-actions',
    events: {
        /** Only fires for an enabled button. */
        actionClicked: defineElementEvent<ReviewPaneAction>(),
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 16px;
        }

        .status {
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
    `,
    render({inputs, dispatch, events}) {
        const canPostVerdict = !!inputs.review && canPostVerdictByStatus[inputs.review.status];
        const isEnded = !inputs.review || inputs.review.status === ManualReviewStatus.Aborted;

        function renderButton({
            action,
            text,
            color,
            isDisabled,
            buttonEmphasis,
            tooltipText,
        }: Readonly<
            {
                action: ReviewPaneAction;
                text: string;
                color: ViraColorVariant;
                isDisabled: boolean;
            } & PartialWithUndefined<{
                buttonEmphasis: ViraEmphasis;
                tooltipText: string;
            }>
        >) {
            return html`
                <${ViraButton.assign({
                    text,
                    color,
                    buttonSize: ViraSize.Large,
                    buttonEmphasis,
                    isDisabled,
                })}
                    ${tooltipText ? tooltip(tooltipText) : nothing}
                    ${listen('click', () => {
                        if (isDisabled) {
                            return;
                        }
                        dispatch(
                            new events.actionClicked({
                                detail: action,
                            }),
                        );
                    })}
                ></${ViraButton}>
            `;
        }

        function renderStatus() {
            if (!inputs.review) {
                return 'Not started';
            } else if (inputs.review.isPending) {
                return pendingStatusLabels[inputs.review.status];
            } else {
                return inputs.review.headSha
                    ? `${statusLabels[inputs.review.status]} at ${inputs.review.headSha.slice(0, 7)}`
                    : statusLabels[inputs.review.status];
            }
        }

        return html`
            <span class="status">${renderStatus()}</span>
            <div class="buttons">
                ${renderButton({
                    action: ReviewPaneAction.Start,
                    text: 'Start Manual Review',
                    color: ViraColorVariant.Positive,
                    isDisabled: inputs.isLocked || canPostVerdict,
                })}
                ${renderButton({
                    action: ReviewPaneAction.Reset,
                    text: 'Reset',
                    color: ViraColorVariant.Neutral,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    tooltipText:
                        'Start this review over: un-read every file so the whole PR is up for review again.',
                    isDisabled: inputs.isLocked || isEnded,
                })}
                ${renderButton({
                    action: ReviewPaneAction.Abort,
                    text: 'Abort',
                    color: ViraColorVariant.Danger,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    tooltipText:
                        'Walk away from this review: discard the comments it has not posted and its review branch or copy. Nothing is posted.',
                    isDisabled: inputs.isLocked || isEnded,
                })}
            </div>
            <div class="buttons">
                ${renderButton({
                    action: ReviewPaneAction.Approve,
                    text: 'Approve',
                    color: ViraColorVariant.Positive,
                    isDisabled: inputs.isLocked || !canPostVerdict,
                })}
                ${renderButton({
                    action: ReviewPaneAction.RequestChanges,
                    text: 'Request Changes',
                    color: ViraColorVariant.Danger,
                    isDisabled: inputs.isLocked || !canPostVerdict,
                })}
            </div>
        `;
    },
});
