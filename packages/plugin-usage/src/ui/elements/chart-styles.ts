import {colorCss} from '@electrovir/color';
import {css} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/** Shared by the charts: legend, axis labels and the hover tooltip. */
export const chartStyles = css`
    .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 12px;
        color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
    }

    .legend-item {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .swatch {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        flex-shrink: 0;
    }

    .axis-label {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        white-space: nowrap;
    }

    .tooltip {
        position: absolute;
        z-index: 1;
        top: 0;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 10px;
        border-radius: 6px;
        font-size: 12px;
        white-space: nowrap;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
        ${colorCss(viraThemeByKeys.grey.foreground.body)};

        & .tooltip-title {
            font-weight: bold;
        }

        & .tooltip-row {
            display: flex;
            align-items: center;
            gap: 6px;
            font-variant-numeric: tabular-nums;

            & .tooltip-value {
                flex-grow: 1;
                text-align: right;
                padding-left: 12px;
            }
        }
    }
`;
