import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, listen} from 'element-vir';
import {type PaneReviewObservable} from '../../util/pane-review.js';
import {type PrReviewsObservable} from '../../util/pr-reviews.js';
import {VirReviewPane} from './vir-review-pane.element.js';

/** A pane group's Review pane: the manual review of the folder's PR, or why there's no PR to review. */
export const VirPaneReview = defineAppElement<{
    folder: string;
    isReviewFolder: boolean;
    paneReview: PaneReviewObservable;
    prReviews: PrReviewsObservable;
    isMobile: boolean;
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
                isPrCheckedOut: !inputs.isReviewFolder,
                review,
                prReviews: inputs.prReviews,
            })}
                ${listen(VirReviewPane.events.manualReviewRequested, async (event) => {
                    /** Goes through a review start so a fresh start also runs the init command. */
                    const isSent = inputs.paneReview.sendReviewStart({
                        reviewStart: {
                            ...event.detail,
                            reviewUpdatedAt: review?.lastUpdatedAt ?? 0,
                            isSent: false,
                        },
                        isMobile: inputs.isMobile,
                    });
                    if (!isSent) {
                        /** Reports that the AI pane has no session to type into yet. */
                        await inputs.paneReview.sendPrompt({
                            prompt: event.detail.prompt,
                            isMobile: inputs.isMobile,
                        });
                    }
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
