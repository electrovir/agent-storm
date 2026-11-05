import {css} from 'element-vir';
import {ViraMenuItem, viraThemeByKeys} from 'vira';

/** Styles for the per-folder menus that a sidebar row and a repo header both render. */
export const sidebarFolderMenuStyles = css`
    /* Colors the item's icon too, which inherits the text color. */
    ${ViraMenuItem}:has(.danger-menu-item) {
        color: ${viraThemeByKeys.red.foreground.body.foreground.value};
    }

    .actions {
        display: inline-flex;
        gap: 2px;
    }
`;
