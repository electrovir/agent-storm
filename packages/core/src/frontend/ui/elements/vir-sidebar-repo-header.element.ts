import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    PopoverAnchor,
    PopoverTrigger,
    renderMenuItemEntries,
    type ViraMenuItemEntry,
    ViraMenuTrigger,
    viraThemeByKeys,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {sidebarContextMenuOffset, sidebarFolderMenuStyles} from './sidebar-menu-styles.js';

/** The heading above a repo's sidebar rows. Right-clicking it opens the repo's menu. */
export const VirSidebarRepoHeader = defineAppElement<{
    name: string;
    count: number;
    isMenuOpen: boolean;
    mobileModal: boolean | undefined;
    menuEntries: ReadonlyArray<Readonly<ViraMenuItemEntry>>;
}>()({
    tagName: 'vir-sidebar-repo-header',
    events: {
        menuOpenChange: defineElementEvent<boolean>(),
    },
    hostClasses: {
        'vir-sidebar-repo-header-mobile'({inputs}) {
            return !!inputs.mobileModal;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: block;
            }

            ${sidebarFolderMenuStyles}

            /* A menu trigger is inline by default, which would shrink the row to its content. */
            ${ViraMenuTrigger} {
                display: flex;
            }

            /* The menu trigger wraps the header in a button, which centers its text. */
            .header {
                flex-grow: 1;
                text-align: start;
                padding: 6px 5px 2px;
                font-weight: 600;

                &[data-menu-open] {
                    background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                        .value};
                }
            }

            /* Deliberately outside the header's bold weight so only the repo name reads as a heading. */
            .count {
                font-weight: 400;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            ${hostClasses['vir-sidebar-repo-header-mobile'].selector} .header {
                padding: 10px 16px 4px;
            }
        `;
    },
    render({inputs, dispatch, events}) {
        return html`
            <${ViraMenuTrigger.assign({
                trigger: PopoverTrigger.ContextMenu,
                popoverAnchor: PopoverAnchor.Mouse,
                popoverOffset: sidebarContextMenuOffset,
            })}
                ${listen(ViraMenuTrigger.events.openChange, (event) => {
                    dispatch(
                        new events.menuOpenChange({
                            detail: event.detail,
                        }),
                    );
                })}
            >
                <div
                    class="header"
                    slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                    ?data-menu-open=${inputs.isMenuOpen}
                >
                    ${inputs.name}
                    <span class="count">(${inputs.count})</span>
                </div>
                ${renderMenuItemEntries(inputs.menuEntries)}
            </${ViraMenuTrigger}>
        `;
    },
});
