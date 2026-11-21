import {defineAppElement} from '@agent-storm/core/frontend';
import {extractEventTarget} from '@augment-vir/web';
import {css, html, listen, nothing, svg, unsafeCSS} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {chartStyles} from './chart-styles.js';

/** One reading on a line chart. */
export type LineChartPoint = Readonly<{
    /** Epoch milliseconds. */
    at: number;
    percent: number;
}>;

/** Width of the SVG's coordinate space, which stretches to the element's width. */
const plotWidth = 1000;

/**
 * One percentage over time, from 0 to 100, with a crosshair and tooltip on the reading nearest the
 * pointer.
 */
export const VirUsageLineChart = defineAppElement<{
    points: ReadonlyArray<LineChartPoint>;
    /** Epoch milliseconds of the chart's left edge. */
    startAt: number;
    /** Epoch milliseconds of the chart's right edge. */
    endAt: number;
    color: string;
    formatTime: (at: number) => string;
}>()({
    tagName: 'vir-usage-line-chart',
    styles: css`
        :host {
            display: grid;
            grid-template-columns: auto 1fr;
            column-gap: 8px;
            height: 64px;
        }

        ${chartStyles}

        .y-axis {
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: flex-end;
        }

        .area {
            position: relative;
            min-width: 0;
        }

        svg {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            overflow: visible;
        }

        .grid-line {
            stroke: ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            stroke-width: 1px;
            opacity: 0.6;
        }

        .line {
            fill: none;
            stroke-width: 2px;
            stroke-linejoin: round;
        }

        .crosshair {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 1px;
            pointer-events: none;
            background-color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .marker {
            position: absolute;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            pointer-events: none;
            transform: translate(-50%, 50%);
            box-shadow: 0 0 0 2px ${viraThemeByKeys.grey.foreground.body.background.value};
        }

        .empty {
            display: flex;
            align-items: center;
            height: 100%;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }
    `,
    state() {
        return {
            hoveredIndex: undefined as number | undefined,
        };
    },
    render({inputs, state, updateState}) {
        const span = Math.max(1, inputs.endAt - inputs.startAt);

        function toLeftFraction(at: number) {
            return Math.min(1, Math.max(0, (at - inputs.startAt) / span));
        }

        const hoveredPoint =
            state.hoveredIndex == undefined ? undefined : inputs.points[state.hoveredIndex];

        return html`
            <div class="y-axis">
                <span class="axis-label">100%</span>
                <span class="axis-label">0%</span>
            </div>
            <div
                class="area"
                ${listen('mousemove', (event) => {
                    const area = extractEventTarget(event, HTMLElement);
                    const pointerAt =
                        inputs.startAt +
                        ((event.clientX - area.getBoundingClientRect().left) /
                            Math.max(1, area.clientWidth)) *
                            span;
                    const nearest = inputs.points.reduce(
                        (best, point, index) => {
                            const distance = Math.abs(point.at - pointerAt);
                            return distance < best.distance
                                ? {
                                      index,
                                      distance,
                                  }
                                : best;
                        },
                        {
                            index: -1,
                            distance: Infinity,
                        },
                    );
                    updateState({
                        hoveredIndex: nearest.index < 0 ? undefined : nearest.index,
                    });
                })}
                ${listen('mouseleave', () => {
                    updateState({
                        hoveredIndex: undefined,
                    });
                })}
            >
                ${inputs.points.length
                    ? html`
                          <svg viewBox="0 0 ${plotWidth} 100" preserveAspectRatio="none">
                              ${[
                                  0,
                                  50,
                                  100,
                              ].map((percent) => {
                                  return svg`
                                      <line
                                          class="grid-line"
                                          x1="0"
                                          x2=${plotWidth}
                                          y1=${100 - percent}
                                          y2=${100 - percent}
                                          vector-effect="non-scaling-stroke"
                                      ></line>
                                  `;
                              })}
                              <polyline
                                  class="line"
                                  stroke=${inputs.color}
                                  vector-effect="non-scaling-stroke"
                                  points=${inputs.points
                                      .map((point) => {
                                          return [
                                              toLeftFraction(point.at) * plotWidth,
                                              100 - point.percent,
                                          ].join(',');
                                      })
                                      .join(' ')}
                              ></polyline>
                          </svg>
                      `
                    : html`
                          <span class="empty">No readings in this range yet.</span>
                      `}
                ${hoveredPoint
                    ? html`
                          <div
                              class="crosshair"
                              style=${css`
                                  left: ${toLeftFraction(hoveredPoint.at) * 100}%;
                              `}
                          ></div>
                          <div
                              class="marker"
                              style=${css`
                                  left: ${toLeftFraction(hoveredPoint.at) * 100}%;
                                  bottom: ${hoveredPoint.percent}%;
                                  background-color: ${unsafeCSS(inputs.color)};
                              `}
                          ></div>
                          <div
                              class="tooltip"
                              style=${toLeftFraction(hoveredPoint.at) < 0.5
                                  ? css`
                                        left: ${toLeftFraction(hoveredPoint.at) * 100}%;
                                        margin-left: 12px;
                                    `
                                  : css`
                                        right: ${(1 - toLeftFraction(hoveredPoint.at)) * 100}%;
                                        margin-right: 12px;
                                    `}
                          >
                              <span class="tooltip-title">
                                  ${inputs.formatTime(hoveredPoint.at)}
                              </span>
                              <span class="tooltip-row">
                                  Used
                                  <span class="tooltip-value">
                                      ${Math.round(hoveredPoint.percent)}%
                                  </span>
                              </span>
                          </div>
                      `
                    : nothing}
            </div>
        `;
    },
});
