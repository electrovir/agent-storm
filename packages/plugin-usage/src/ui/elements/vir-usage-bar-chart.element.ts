import {defineAppElement} from '@agent-storm/core/frontend';
import {css, html, listen, nothing, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {findAxisTicks} from '../../util/usage-chart.js';
import {chartStyles} from './chart-styles.js';

/** One stacked layer of a bar chart: a value for each column. */
export type BarChartSeries = Readonly<{
    label: string;
    color: string;
    values: ReadonlyArray<number>;
}>;

/**
 * Stacked bars, one column per label, with a tooltip listing each series' value in the hovered
 * column. Series stack bottom to top in their given order.
 */
export const VirUsageBarChart = defineAppElement<{
    columnLabels: ReadonlyArray<string>;
    series: ReadonlyArray<BarChartSeries>;
    formatValue: (value: number) => string;
}>()({
    tagName: 'vir-usage-bar-chart',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        ${chartStyles}

        .frame {
            display: grid;
            grid-template-columns: auto 1fr;
            grid-template-rows: 180px auto;
            column-gap: 8px;
            row-gap: 4px;
        }

        .y-axis {
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            min-width: 32px;

            & .axis-label {
                position: absolute;
                right: 0;
                transform: translateY(50%);
            }
        }

        .area {
            position: relative;
            flex-grow: 1;
            min-width: 0;
        }

        .grid-line {
            position: absolute;
            left: 0;
            right: 0;
            height: 1px;
            background-color: ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            opacity: 0.6;
        }

        .columns {
            position: absolute;
            inset: 0;
            display: flex;
        }

        .column {
            display: flex;
            flex-direction: column-reverse;
            align-items: center;
            flex-grow: 1;
            flex-basis: 0;
            min-width: 0;

            &.hovered {
                background-color: ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            }
        }

        .segment {
            width: min(24px, calc(100% - 2px));
            flex-shrink: 0;

            /* Separates stacked segments with the surface. */
            &:not(:first-child) {
                margin-bottom: 2px;
            }

            &:last-child {
                border-radius: 4px 4px 0 0;
            }
        }

        .x-axis {
            grid-column: 2;
            display: flex;
            justify-content: space-between;
        }
    `,
    state() {
        return {
            hoveredIndex: undefined as number | undefined,
        };
    },
    render({inputs, state, updateState}) {
        const columnTotals = inputs.columnLabels.map((label, index) => {
            return inputs.series.reduce((sum, series) => sum + (series.values[index] || 0), 0);
        });
        const ticks = findAxisTicks(Math.max(0, ...columnTotals));
        const top = ticks.at(-1) || 1;
        const hoveredIndex = state.hoveredIndex;
        const xLabelIndexes = [
            0,
            Math.floor((inputs.columnLabels.length - 1) / 2),
            inputs.columnLabels.length - 1,
        ].filter((index, position, all) => index >= 0 && all.indexOf(index) === position);

        return html`
            <div class="frame">
                <div class="y-axis">
                    ${ticks.map((tick) => {
                        return html`
                            <span
                                class="axis-label"
                                style=${css`
                                    bottom: ${(tick / top) * 100}%;
                                `}
                            >
                                ${inputs.formatValue(tick)}
                            </span>
                        `;
                    })}
                </div>
                <div
                    class="area"
                    ${listen('mouseleave', () => {
                        updateState({
                            hoveredIndex: undefined,
                        });
                    })}
                >
                    ${ticks.map((tick) => {
                        return html`
                            <div
                                class="grid-line"
                                style=${css`
                                    bottom: ${(tick / top) * 100}%;
                                `}
                            ></div>
                        `;
                    })}
                    <div class="columns">
                        ${inputs.columnLabels.map((label, index) => {
                            return html`
                                <div
                                    class="column ${index === hoveredIndex ? 'hovered' : ''}"
                                    ${listen('mouseenter', () => {
                                        updateState({
                                            hoveredIndex: index,
                                        });
                                    })}
                                >
                                    ${inputs.series
                                        .filter((series) => (series.values[index] || 0) > 0)
                                        .map((series) => {
                                            return html`
                                                <div
                                                    class="segment"
                                                    style=${css`
                                                        height: ${((series.values[index] || 0) /
                                                            top) *
                                                        100}%;
                                                        background-color: ${unsafeCSS(
                                                            series.color,
                                                        )};
                                                    `}
                                                ></div>
                                            `;
                                        })}
                                </div>
                            `;
                        })}
                    </div>
                    ${hoveredIndex == undefined
                        ? nothing
                        : html`
                              <div
                                  class="tooltip"
                                  style=${hoveredIndex < inputs.columnLabels.length / 2
                                      ? css`
                                            left: ${((hoveredIndex + 1) /
                                                inputs.columnLabels.length) *
                                            100}%;
                                            margin-left: 8px;
                                        `
                                      : css`
                                            right: ${(1 -
                                                hoveredIndex / inputs.columnLabels.length) *
                                            100}%;
                                            margin-right: 8px;
                                        `}
                              >
                                  <span class="tooltip-title">
                                      ${inputs.columnLabels[hoveredIndex]}
                                  </span>
                                  ${inputs.series.map((series) => {
                                      return html`
                                          <span class="tooltip-row">
                                              <span
                                                  class="swatch"
                                                  style=${css`
                                                      background-color: ${unsafeCSS(series.color)};
                                                  `}
                                              ></span>
                                              ${series.label}
                                              <span class="tooltip-value">
                                                  ${inputs.formatValue(
                                                      series.values[hoveredIndex] || 0,
                                                  )}
                                              </span>
                                          </span>
                                      `;
                                  })}
                                  ${inputs.series.length > 1
                                      ? html`
                                            <span class="tooltip-row">
                                                Total
                                                <span class="tooltip-value">
                                                    ${inputs.formatValue(
                                                        columnTotals[hoveredIndex] || 0,
                                                    )}
                                                </span>
                                            </span>
                                        `
                                      : nothing}
                              </div>
                          `}
                </div>
                <div class="x-axis">
                    ${xLabelIndexes.map((index) => {
                        return html`
                            <span class="axis-label">${inputs.columnLabels[index]}</span>
                        `;
                    })}
                </div>
            </div>
            ${inputs.series.length > 1
                ? html`
                      <div class="legend">
                          ${inputs.series.map((series) => {
                              return html`
                                  <span class="legend-item">
                                      <span
                                          class="swatch"
                                          style=${css`
                                              background-color: ${unsafeCSS(series.color)};
                                          `}
                                      ></span>
                                      ${series.label}
                                  </span>
                              `;
                          })}
                      </div>
                  `
                : nothing}
        `;
    },
});
