import {type FolderInfo} from '@agent-storm/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {PopoverTrigger, renderMenuItemEntries, ViraMenuTrigger, viraThemeByKeys} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {sidebarContextMenuOffset, sidebarFolderMenuStyles} from './sidebar-menu-styles.js';
import {buildRepoMenuEntries, type SidebarFolderAction} from './sidebar-menus.js';

/** The heading above a worktree root's rows, with the menu for the repo as a whole. */
export const VirSidebarRepoHeader = defineAppElement<{
    root: FolderInfo;
    /** Every worktree the repo has, including any the current filters hide. */
    worktreeCount: number;
    isMenuOpen: boolean;
    mobileModal: boolean | undefined;
}>()({
    tagName: 'vir-sidebar-repo-header',
    events: {
        menuOpenChange: defineElementEvent<boolean>(),
        actionSelect: defineElementEvent<SidebarFolderAction>(),
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
            .worktree-count {
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
                    ${inputs.root.name}
                    <span class="worktree-count">(${inputs.worktreeCount})</span>
                </div>
                ${renderMenuItemEntries(
                    buildRepoMenuEntries((action) => {
                        dispatch(
                            new events.actionSelect({
                                detail: action,
                            }),
                        );
                    }),
                )}
            </${ViraMenuTrigger}>
        `;
    },
});
