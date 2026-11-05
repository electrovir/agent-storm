import {type FolderInfo} from '@agent-storm/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    LucideEllipsisIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {sidebarTooltipOptions} from '../../util/sidebar-display.js';
import {defineAppElement} from '../define-app-element.js';
import {sidebarFolderMenuStyles} from './sidebar-menu-styles.js';
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
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 6px;
                padding: 6px 5px 2px;
                font-weight: 600;
            }

            ${sidebarFolderMenuStyles}

            .actions {
                opacity: 0;
                /* The menu pops up inside the header, so it would inherit the repo name's bold. */
                font-weight: 300;
            }

            :host(:hover) .actions,
            .actions[data-menu-open] {
                opacity: 1;
            }

            /* Deliberately outside the header's bold weight so only the repo name reads as a heading. */
            .worktree-count {
                font-weight: 400;
                color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }

            ${hostClasses['vir-sidebar-repo-header-mobile'].selector} {
                padding: 10px 16px 4px;
            }
        `;
    },
    render({inputs, dispatch, events}) {
        return html`
            <span>
                ${inputs.root.name}
                <span class="worktree-count">(${inputs.worktreeCount})</span>
            </span>
            <span class="actions" ?data-menu-open=${inputs.isMenuOpen}>
                <${ViraMenuTrigger}
                    ${listen(ViraMenuTrigger.events.openChange, (event) => {
                        dispatch(
                            new events.menuOpenChange({
                                detail: event.detail,
                            }),
                        );
                    })}
                >
                    <${ViraButton.assign({
                        icon: LucideEllipsisIcon,
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        ${tooltip('Repo actions', sidebarTooltipOptions)}
                    ></${ViraButton}>
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
            </span>
        `;
    },
});
