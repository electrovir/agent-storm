import {defineAppElement} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {css, html, onDomRendered} from 'element-vir';
import {destroyChart, drawChart, readChartTheme} from './draw-chart.js';

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
            display: block;
            position: relative;
            height: 220px;
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
                        type: 'bar',
                        data: {
                            labels: [...inputs.columnLabels],
                            datasets: inputs.series.map((series) => {
                                return {
                                    label: series.label,
                                    data: [...series.values],
                                    backgroundColor: series.color,
                                    borderColor: series.color,
                                    borderRadius: 4,
                                    maxBarThickness: 24,
                                };
                            }),
                        },
                        options: {
                            ...theme.options,
                            interaction: {
                                mode: 'index',
                                intersect: false,
                            },
                            scales: {
                                x: {
                                    ...theme.scale,
                                    stacked: true,
                                    grid: {
                                        display: false,
                                    },
                                    ticks: {
                                        ...theme.scale.ticks,
                                        maxRotation: 0,
                                        autoSkipPadding: 16,
                                    },
                                },
                                y: {
                                    ...theme.scale,
                                    stacked: true,
                                    beginAtZero: true,
                                    border: {
                                        display: false,
                                    },
                                    ticks: {
                                        ...theme.scale.ticks,
                                        maxTicksLimit: 5,
                                        callback(value) {
                                            return inputs.formatValue(Number(value));
                                        },
                                    },
                                },
                            },
                            plugins: {
                                legend: {
                                    display: inputs.series.length > 1,
                                    position: 'bottom',
                                    align: 'start',
                                    labels: {
                                        color: theme.colors.legend,
                                        font: theme.scale.ticks.font,
                                        boxWidth: 10,
                                        boxHeight: 10,
                                    },
                                },
                                tooltip: {
                                    ...theme.tooltip,
                                    callbacks: {
                                        label(item) {
                                            return `${item.dataset.label || ''}: ${inputs.formatValue(item.parsed.y ?? 0)}`;
                                        },
                                        footer(items) {
                                            return inputs.series.length > 1
                                                ? `Total: ${inputs.formatValue(
                                                      items.reduce(
                                                          (sum, item) => sum + (item.parsed.y ?? 0),
                                                          0,
                                                      ),
                                                  )}`
                                                : '';
                                        },
                                    },
                                },
                            },
                        },
                    });
                })}
            ></canvas>
        `;
    },
});
