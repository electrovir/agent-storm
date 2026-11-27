import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, listen, nothing} from 'element-vir';
import {tooltip, ViraButton, ViraEmphasis, ViraSize, viraThemeByKeys} from 'vira';
import {
    type UsageGroup,
    usageProviderLabels,
    usageSourceLabels,
    type UsageTotals,
} from '../../usage-api.js';
import {
    findPathName,
    formatTokenCount,
    formatUsd,
    shortenPrUrl,
    UsageMeasure,
    usageMeasureReaders,
} from '../../util/usage-chart.js';

const collapsedRowCount = 10;

/** What a group's row names it by: its own label, else its PR, else its folder. */
function findGroupName(group: Readonly<UsageGroup>) {
    return group.label || (group.prUrl ? shortenPrUrl(group.prUrl) : findPathName(group.folder));
}

function findGroupLocation(group: Readonly<UsageGroup>) {
    const repoName = findPathName(group.repoPath);
    return group.folder === group.repoPath
        ? repoName
        : [
              repoName,
              findPathName(group.folder),
          ].join(' / ');
}

/** A cost, marked when part of it is estimated or when some tokens couldn't be priced. */
export function renderCost(totals: Readonly<UsageTotals>) {
    const notes = [
        totals.hasEstimatedCost ? 'Includes cost estimated from public list prices.' : '',
        totals.hasUnpricedTokens ? 'Some tokens used a model without a known price.' : '',
    ].filter(Boolean);
    return notes.length
        ? html`
              <span ${tooltip(notes.join(' '))}>${formatUsd(totals.costUsd)}*</span>
          `
        : formatUsd(totals.costUsd);
}

/**
 * Usage for each folder, thread and PR that ran AI, most expensive first. Only the top rows show
 * until the user asks for all of them.
 */
export const VirUsageBreakdown = defineAppElement<{
    groups: ReadonlyArray<Readonly<UsageGroup>>;
}>()({
    tagName: 'vir-usage-breakdown',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }

        th {
            text-align: left;
            font-weight: normal;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        th,
        td {
            padding: 6px 8px;
            border-bottom: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        }

        .number {
            text-align: right;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }

        .location {
            display: block;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .empty {
            font-size: 13px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }
    `,
    state() {
        return {
            isShowingAll: false,
        };
    },
    render({inputs, state, updateState}) {
        if (!inputs.groups.length) {
            return html`
                <span class="empty">No AI usage was recorded in this range.</span>
            `;
        }
        const isCollapsed = !state.isShowingAll && inputs.groups.length > collapsedRowCount;
        return html`
            <table>
                <thead>
                    <tr>
                        <th>Plugin</th>
                        <th>Where</th>
                        <th>Provider</th>
                        <th class="number">Tokens</th>
                        <th class="number">Cost</th>
                    </tr>
                </thead>
                <tbody>
                    ${(isCollapsed ? inputs.groups.slice(0, collapsedRowCount) : inputs.groups).map(
                        (group) => {
                            return html`
                                <tr>
                                    <td>${usageSourceLabels[group.source]}</td>
                                    <td>
                                        ${findGroupName(group)}
                                        <span class="location">${findGroupLocation(group)}</span>
                                    </td>
                                    <td>${usageProviderLabels[group.provider]}</td>
                                    <td class="number">
                                        ${formatTokenCount(
                                            usageMeasureReaders[UsageMeasure.Tokens](group.totals),
                                        )}
                                    </td>
                                    <td class="number">${renderCost(group.totals)}</td>
                                </tr>
                            `;
                        },
                    )}
                </tbody>
            </table>
            ${isCollapsed
                ? html`
                      <${ViraButton.assign({
                          text: 'Show all',
                          buttonSize: ViraSize.Small,
                          buttonEmphasis: ViraEmphasis.Subtle,
                      })}
                          ${listen('click', () => {
                              updateState({
                                  isShowingAll: true,
                              });
                          })}
                      ></${ViraButton}>
                  `
                : nothing}
        `;
    },
});
