import {defineAppElement} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {css, html, nothing, onDomRendered} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {destroyChart, drawChart, readChartTheme} from './draw-chart.js';

/** One reading on a line chart. */
export type LineChartPoint = Readonly<{
    /** Epoch milliseconds. */
    at: number;
    percent: number;
}>;

/** One percentage over time, from 0 to 100, with a tooltip on the reading nearest the pointer. */
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
            display: block;
            position: relative;
            height: 64px;
        }

        .empty {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            pointer-events: none;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }
    `,
    cleanup({host}) {
        destroyChart(host);
    },
    render({inputs}) {
        return html`
            <canvas
                ${onDomRendered((element) => {
                    const canvas = assertWrap.instanceOf(element, HTMLCanvasElement);
                    if (!canvas.isConnected) {
                        return;
                    }
                    const theme = readChartTheme(canvas);
                    drawChart(canvas, {
                        type: 'line',
                        data: {
                            datasets: [
                                {
                                    data: inputs.points.map((point) => {
                                        return {
                                            x: point.at,
                                            y: point.percent,
                                        };
                                    }),
                                    borderColor: inputs.color,
                                    borderWidth: 2,
                                    borderJoinStyle: 'round',
                                    pointRadius: 0,
                                    pointHoverRadius: 4,
                                    pointHoverBackgroundColor: inputs.color,
                                    pointHoverBorderColor: theme.colors.surface,
                                    pointHoverBorderWidth: 2,
                                },
                            ],
                        },
                        options: {
                            ...theme.options,
                            interaction: {
                                mode: 'nearest',
                                axis: 'x',
                                intersect: false,
                            },
                            scales: {
                                x: {
                                    type: 'linear',
                                    display: false,
                                    min: inputs.startAt,
                                    max: inputs.endAt,
                                },
                                y: {
                                    ...theme.scale,
                                    min: 0,
                                    max: 100,
                                    border: {
                                        display: false,
                                    },
                                    ticks: {
                                        ...theme.scale.ticks,
                                        stepSize: 50,
                                        callback(value) {
                                            return `${value}%`;
                                        },
                                    },
                                },
                            },
                            plugins: {
                                legend: {
                                    display: false,
                                },
                                tooltip: {
                                    ...theme.tooltip,
                                    displayColors: false,
                                    callbacks: {
                                        title(items) {
                                            return items.map((item) => {
                                                return inputs.formatTime(item.parsed.x ?? 0);
                                            });
                                        },
                                        label(item) {
                                            return `Used ${Math.round(item.parsed.y ?? 0)}%`;
                                        },
                                    },
                                },
                            },
                        },
                    });
                })}
            ></canvas>
            ${inputs.points.length
                ? nothing
                : html`
                      <span class="empty">No readings in this range yet.</span>
                  `}
        `;
    },
});
