import {getObjectTypedKeys} from '@augment-vir/common';
import {defineBookPage} from 'element-book';
import {css, html, nothing} from 'element-vir';
import {tooltip, ViraIcon, type ViraIconSvg} from 'vira';
import {
    localChangesIcon,
    localChangesTooltip,
    prRingRanks,
    prStatusIcons,
    prStatusTooltips,
} from '../../util/sidebar-display.js';

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
                    ...getObjectTypedKeys(prRingRanks)
                        .filter((prStatus) => prRingRanks[prStatus] > 0)
                        .toSorted((first, second) => prRingRanks[first] - prRingRanks[second])
                        .flatMap((prStatus) => {
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
