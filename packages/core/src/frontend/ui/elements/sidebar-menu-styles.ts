import {css} from 'element-vir';
import {type PopoverOffset, ViraMenuItem, viraThemeByKeys} from 'vira';

/** Styles for the context menus that sidebar rows and headers render. */
export const sidebarFolderMenuStyles = css`
    /* Menu items inherit the font from where their trigger sits, so pin it to the sidebar list's. */
    ${ViraMenuItem} {
        font-size: 13px;
        font-weight: 300;
        letter-spacing: 0.01em;
    }

    /* Colors the item's icon too, which inherits the text color. */
    ${ViraMenuItem}:has(.danger-menu-item) {
        color: ${viraThemeByKeys.red.foreground.body.foreground.value};
    }
`;

/**
 * For a context menu whose trigger is a whole sidebar row. Vira gives a popover a minimum width of
 * its trigger's width minus this right offset, so a large offset lets the menu fit its items
 * instead of stretching across the row.
 */
export const sidebarContextMenuOffset: PopoverOffset = {
    right: 10_000,
};
