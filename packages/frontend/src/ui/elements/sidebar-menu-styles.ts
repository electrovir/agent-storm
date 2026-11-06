import {css} from 'element-vir';
import {type PopoverOffset, ViraMenuItem, viraThemeByKeys} from 'vira';

/** Styles for the per-folder menus that a sidebar row and a repo header both render. */
export const sidebarFolderMenuStyles = css`
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
