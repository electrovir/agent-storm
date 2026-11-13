import {css} from 'element-vir';
import {ViraIcon, viraThemeByKeys} from 'vira';

/** Styles for `.menu-item` rows inside a small popup menu. */
export const menuItemStyles = css`
    .menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 28px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 14px;
        cursor: pointer;
        user-select: none;
        color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

        &:hover {
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        & ${ViraIcon} {
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    }
`;
