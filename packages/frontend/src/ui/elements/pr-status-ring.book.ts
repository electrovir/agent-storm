import {PrStatus} from '@agent-storm/common';
import {defineBookPage} from 'element-book';
import {css, html, nothing} from 'element-vir';
import {tooltip, ViraIcon, type ViraIconSvg} from 'vira';
import {
    localChangesIcon,
    localChangesTooltip,
    prStatusIcons,
    prStatusTooltips,
} from '../../util/sidebar-display.js';

/**
 * Lowest precedence first, following the checks in the server's `toOpenPrStatus`. Approved and
 * ChangesRequested never compete, unresolved comments outrank only an approval, and
 * `AwaitingReview` only falls through to its last check when nothing above it applies.
 * `ReReviewRequested` never competes with `AwaitingReview`.
 */
const precedenceOrder: ReadonlyArray<PrStatus> = [
    PrStatus.Approved,
    PrStatus.UnresolvedComments,
    PrStatus.ChangesRequested,
    PrStatus.ChecksFailed,
    PrStatus.AwaitingOtherReviews,
    PrStatus.OthersRequestedChanges,
    PrStatus.AwaitingReview,
    PrStatus.ReReviewRequested,
    PrStatus.ReviewStarted,
    PrStatus.ReadyToMerge,
    PrStatus.Merged,
];

export const prStatusRingPage = defineBookPage({
    parent: undefined,
    title: 'PR status ring',
    defineExamples({defineExample}) {
        defineExample({
            title: 'Precedence, lowest to highest',
            styles: css`
                .rings {
                    display: flex;
                    align-items: flex-start;
                    gap: 12px;
                }

                .ring {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 4px;
                    width: 96px;
                    text-align: center;
                    font-size: 12px;
                }

                .separator {
                    padding-top: 2px;
                }
            `,
            render() {
                const rings: ReadonlyArray<{
                    icon: ViraIconSvg;
                    tooltipText: string;
                }> = [
                    {
                        icon: localChangesIcon,
                        tooltipText: localChangesTooltip,
                    },
                    ...precedenceOrder.flatMap((prStatus) => {
                        const icon = prStatusIcons[prStatus];
                        return icon
                            ? [
                                  {
                                      icon,
                                      tooltipText: prStatusTooltips[prStatus],
                                  },
                              ]
                            : [];
                    }),
                ];
                return html`
                    <div class="rings">
                        ${rings.map(({icon, tooltipText}, index) => {
                            return html`
                                ${index
                                    ? html`
                                          <span class="separator">&lt;</span>
                                      `
                                    : nothing}
                                <div class="ring" ${tooltip(tooltipText)}>
                                    <${ViraIcon.assign({
                                        icon,
                                    })}></${ViraIcon}>
                                    <span>${tooltipText}</span>
                                </div>
                            `;
                        })}
                    </div>
                `;
            },
        });
    },
});
