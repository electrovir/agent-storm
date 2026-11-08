import {css, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraSize} from 'vira';
import {ReviewVerdict, type FrontendStateObservable} from '../../util/frontend-state.js';
import {DiffView} from '../../util/pane-layout.js';
import {canPostVerdict, type PaneReviewObservable} from '../../util/pane-review.js';
import {ScreenSize} from '../../util/screen-size.js';
import {defineAppElement} from '../define-app-element.js';
import {VirDiffPane} from './vir-diff-pane.element.js';

/**
 * A pane group's Diff tab: the folder's own diff and, for a Build folder, its manual review copy's
 * diff. Lays its panes over the pane group's body, so it stays mounted while another tab shows.
 */
export const VirPaneDiff = defineAppElement<{
    folder: string;
    /** Whether the pane group is active and on its Diff tab. */
    isShown: boolean;
    diffView: DiffView;
    /** Its review copy is mounted once the skill has made one, even while it can't be shown. */
    paneReview: PaneReviewObservable;
    isReviewCopyReady: boolean;
    /** A review folder's own diff carries the verdict buttons and accepts comments. */
    isReviewFolder: boolean;
    frontendState: FrontendStateObservable | undefined;
    screenSize: ScreenSize;
    /** Picks which diff shows. Kept reachable while the manual review is starting. */
    sourcePicker?: HtmlInterpolation | undefined;
}>()({
    tagName: 'vir-pane-diff',
    styles: css`
        :host {
            display: contents;
        }

        .diff-pane {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: row;
            overflow: hidden;
        }

        .diff-pane[data-hidden] {
            /*
             * Keep the hidden side mounted so its scroll position survives a tab switch. Hiding by
             * visibility preserves it, and killing pointer events makes the hidden side inert to
             * clicks.
             */
            visibility: hidden;
            pointer-events: none;
        }

        .starting-message {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 16px;
            font-size: 12px;
        }
    `,
    render({inputs}) {
        const isVerdictAllowed = canPostVerdict(inputs.paneReview.value);
        const reviewCopyFolder = inputs.paneReview.value.reviewCopyFolder;
        const isSourceShown = inputs.isShown && inputs.diffView === DiffView.Source;
        const isManualReviewChosen = inputs.isShown && inputs.diffView === DiffView.ManualReview;
        const verdictButtons = [
            {
                text: 'Approve',
                color: ViraColorVariant.Positive,
                verdict: ReviewVerdict.Approve,
            },
            {
                text: 'Request Changes',
                color: ViraColorVariant.Danger,
                verdict: ReviewVerdict.RequestChanges,
            },
        ].map(({text, color, verdict}) => {
            return html`
                <${ViraButton.assign({
                    text,
                    color,
                    buttonSize: ViraSize.Small,
                    isDisabled: !isVerdictAllowed,
                })}
                    ${listen('click', async () => {
                        if (isVerdictAllowed) {
                            await inputs.paneReview.requestVerdict({
                                verdict,
                                frontendState: inputs.frontendState,
                                isMobile: inputs.screenSize === ScreenSize.Mobile,
                            });
                        }
                    })}
                ></${ViraButton}>
            `;
        });

        return html`
            <div class="diff-pane" ?data-hidden=${!isSourceShown}>
                <${VirDiffPane.assign({
                    folder: inputs.folder,
                    active: isSourceShown,
                    screenSize: inputs.screenSize,
                    sidebarHeader: inputs.isReviewFolder ? verdictButtons : undefined,
                    toolbarTrailing: inputs.sourcePicker,
                    enableComments: inputs.isReviewFolder,
                })}></${VirDiffPane}>
            </div>
            ${reviewCopyFolder
                ? html`
                      <div
                          class="diff-pane"
                          ?data-hidden=${!isManualReviewChosen || !inputs.isReviewCopyReady}
                      >
                          <${VirDiffPane.assign({
                              folder: reviewCopyFolder,
                              active: isManualReviewChosen,
                              screenSize: inputs.screenSize,
                              sidebarHeader: verdictButtons,
                              toolbarTrailing: inputs.sourcePicker,
                              enableComments: true,
                          })}></${VirDiffPane}>
                      </div>
                  `
                : nothing}
            ${isManualReviewChosen && !inputs.isReviewCopyReady
                ? html`
                      <div class="starting-message">
                          ${inputs.sourcePicker}
                          <span>Starting the manual review…</span>
                      </div>
                  `
                : nothing}
        `;
    },
});
