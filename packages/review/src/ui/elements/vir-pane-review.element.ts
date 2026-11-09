import {
    type PaneReviewObservable,
    type PrReviewsObservable,
    defineAppElement,
} from '@agent-storm/core/frontend';
import {css, html, listen} from 'element-vir';
import {VirReviewPane} from './vir-review-pane.element.js';

/** A pane group's Review pane: the manual review of the folder's PR, or why there's no PR to review. */
export const VirPaneReview = defineAppElement<{
    folder: string;
    paneReview: PaneReviewObservable;
    prReviews: PrReviewsObservable;
    isMobile: boolean;
    /** Starts the review buttons locked, for a pane mounted after a review start was sent. */
    initialPromptSentAt: number | undefined;
}>()({
    tagName: 'vir-pane-review',
    styles: css`
        :host {
            flex-grow: 1;
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .message {
            padding: 16px;
            font-size: 12px;
        }
    `,
    render({inputs}) {
        const {pullRequest, review, buildPrError, isBuildPrMissing} = inputs.paneReview.value;
        if (!pullRequest) {
            return html`
                <div class="message">
                    ${buildPrError ||
                    (isBuildPrMissing ? 'No PR on this branch yet.' : 'Loading the PR…')}
                </div>
            `;
        }
        return html`
            <${VirReviewPane.assign({
                pullRequest,
                folder: inputs.folder,
                review,
                initialPromptSentAt: inputs.initialPromptSentAt,
                prReviews: inputs.prReviews,
            })}
                ${listen(VirReviewPane.events.manualReviewRequested, (event) => {
                    return inputs.paneReview.sendPrompt({
                        prompt: event.detail.prompt,
                        isMobile: inputs.isMobile,
                    });
                })}
                ${listen(VirReviewPane.events.verdictRequested, (event) => {
                    return inputs.paneReview.requestVerdict({
                        verdict: event.detail,
                        isMobile: inputs.isMobile,
                    });
                })}
                ${listen(VirReviewPane.events.manualReviewStarted, () => {
                    inputs.paneReview.markManualReviewStarted();
                })}
            ></${VirReviewPane}>
        `;
    },
});
