import {mapObjectValues, type SetRequiredAndNotNull} from '@augment-vir/common';
import {
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Tooltip,
    type ChartConfiguration,
    type ChartType,
} from 'chart.js';
import {viraThemeByKeys} from 'vira';

Chart.register(
    BarController,
    BarElement,
    CategoryScale,
    Legend,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Tooltip,
);

const themeColors = {
    axis: viraThemeByKeys.grey.foreground.placeholder.foreground,
    grid: viraThemeByKeys.grey.foreground.decoration.foreground,
    legend: viraThemeByKeys.grey.foreground['non-body'].foreground,
    surface: viraThemeByKeys.grey.foreground.body.background,
    text: viraThemeByKeys.grey.foreground.body.foreground,
};

/**
 * The current Vira theme as the colors and options the usage charts share. A canvas can't draw with
 * a CSS variable, so each color is read off a throwaway element's computed `color`.
 */
export function readChartTheme(canvas: Readonly<HTMLCanvasElement>) {
    const colors = mapObjectValues(themeColors, (key, cssVar) => {
        const probe = globalThis.document.createElement('span');
        probe.style.color = String(cssVar.value);
        canvas.after(probe);
        const color = globalThis.getComputedStyle(probe).color;
        probe.remove();
        return color;
    });
    const font = {
        family: globalThis.getComputedStyle(canvas).fontFamily,
        size: 12,
    };

    return {
        colors,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
        },
        /**
         * Spread into every scale: Chart.js styles scales from its global defaults, not from
         * chart-level `color` and `borderColor`.
         */
        scale: {
            grid: {
                color: colors.grid,
            },
            border: {
                color: colors.grid,
            },
            ticks: {
                color: colors.axis,
                font: {
                    ...font,
                    size: 11,
                },
            },
        },
        tooltip: {
            backgroundColor: colors.surface,
            borderColor: colors.grid,
            borderWidth: 1,
            titleColor: colors.text,
            bodyColor: colors.text,
            footerColor: colors.text,
            cornerRadius: 6,
            padding: {
                x: 10,
                y: 8,
            },
            titleFont: font,
            bodyFont: font,
            footerFont: font,
        },
    } as const;
}

/** Draws `config` on `canvas`, updating the chart already drawn there instead of stacking another. */
export function drawChart<const Type extends ChartType>(
    canvas: HTMLCanvasElement,
    config: SetRequiredAndNotNull<ChartConfiguration<Type>, 'options'>,
): Chart<Type> {
    /** Each element draws one chart type on its canvas, always through here. */
    const chart = Chart.getChart(canvas) satisfies Chart<any> | undefined as
        | Chart<Type>
        | undefined;
    if (chart) {
        chart.data = config.data;
        chart.options = config.options;
        chart.update();
        return chart;
    }
    return new Chart(canvas, config);
}

/** Destroys the chart drawn in `host`'s shadow root, if there is one. */
export function destroyChart(host: Readonly<HTMLElement>) {
    const canvas = host.shadowRoot?.querySelector('canvas');
    if (canvas) {
        Chart.getChart(canvas)?.destroy();
    }
}
