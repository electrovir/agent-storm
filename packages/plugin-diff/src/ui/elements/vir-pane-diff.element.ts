import {DiffView, type DiffSelection, type DiffTabState} from '@agent-storm/common';
import {ScreenSize, defineAppElement} from '@agent-storm/core/frontend';
import {ReviewVerdict, canPostVerdict, type PaneReviewObservable} from '@agent-storm/plugin-review';
import {css, defineElementEvent, html, listen, nothing, type HtmlInterpolation} from 'element-vir';
import {ViraButton, ViraColorVariant, ViraSize} from 'vira';
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
    diffSelections: Readonly<DiffTabState['diffSelections']>;
    /** Its review copy is mounted once the skill has made one, even while it can't be shown. */
    paneReview: PaneReviewObservable;
    isReviewCopyReady: boolean;
    /** A review folder's own diff carries the verdict buttons and accepts comments. */
    isReviewFolder: boolean;
    screenSize: ScreenSize;
    /** Picks which diff shows. Kept reachable while the manual review is starting. */
    sourcePicker?: HtmlInterpolation | undefined;
}>()({
    tagName: 'vir-pane-diff',
    events: {
        /** One checkout's list changed what it has open, with only the changed value set. */
        diffSelectionChange: defineElementEvent<{
            diffView: DiffView;
            selection: DiffSelection;
        }>(),
    },
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
    render({inputs, dispatch, events}) {
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
                    savedSelection: inputs.diffSelections[DiffView.Source],
                })}
                    ${listen(VirDiffPane.events.selectionChange, (event) => {
                        dispatch(
                            new events.diffSelectionChange({
                                detail: {
                                    diffView: DiffView.Source,
                                    selection: event.detail,
                                },
                            }),
                        );
                    })}
                ></${VirDiffPane}>
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
                              savedSelection: inputs.diffSelections[DiffView.ManualReview],
                          })}
                              ${listen(VirDiffPane.events.selectionChange, (event) => {
                                  dispatch(
                                      new events.diffSelectionChange({
                                          detail: {
                                              diffView: DiffView.ManualReview,
                                              selection: event.detail,
                                          },
                                      }),
                                  );
                              })}
                          ></${VirDiffPane}>
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
