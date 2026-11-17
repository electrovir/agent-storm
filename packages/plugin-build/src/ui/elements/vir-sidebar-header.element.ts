import {type SidebarGrouping, type SidebarSorting} from '@agent-storm/common';
import {
    AgentStormMarkIcon,
    defineAppElement,
    sidebarTooltipOptions,
    VirSidebarSearch,
} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideEllipsisIcon,
    LucideListFilterIcon,
    LucidePlusIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    type ViraThemeClient,
    ViraThemeSwitcher,
} from 'vira';
import {buildFilterMenuSections} from './sidebar-menus.js';

const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

/**
 * Larger icon variants for the mobile sidebar modal's header buttons. Paired with `ViraSize.Large`
 * so the tap targets land near Apple's HIG-recommended 44px, which the previous `ViraSize.Small` +
 * 16px-icon combo (24px tall) was well short of.
 */
const mobileButtonIconSize = 24;
const mobilePlusIcon = createSizedIcon(LucidePlusIcon, mobileButtonIconSize);
const mobileEllipsisIcon = createSizedIcon(LucideEllipsisIcon, mobileButtonIconSize);
const mobileFilterIcon = createSizedIcon(LucideListFilterIcon, mobileButtonIconSize);

/**
 * The sidebar's top bar: brand, search, add-repo button, and the filter and options menus. The
 * search's events bubble out of it unchanged.
 */
export const VirSidebarHeader = defineAppElement<{
    heading: string | undefined;
    mobileModal: boolean | undefined;
    searchQuery: string;
    /** Whether Enter in the search input has a row to open. */
    hasSearchResult: boolean;
    sidebarGrouping: SidebarGrouping | undefined;
    sidebarSorting: SidebarSorting | undefined;
    onlyShowRecent: boolean | undefined;
    themeClient: Readonly<ViraThemeClient>;
}>()({
    tagName: 'vir-sidebar-header',
    events: {
        addRepoRequest: defineElementEvent<void>(),
        groupingSelect: defineElementEvent<SidebarGrouping>(),
        sortingSelect: defineElementEvent<SidebarSorting>(),
        hideInactiveChange: defineElementEvent<boolean>(),
        settingsRequest: defineElementEvent<void>(),
    },
    hostClasses: {
        'vir-sidebar-header-mobile'({inputs}) {
            return !!inputs.mobileModal;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 5px;
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
                gap: 6px;
            }

            .title {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                font-weight: 600;
                letter-spacing: 0.02em;
                color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
                font-size: 13px;
            }

            .title {
                flex-shrink: 0;
            }

            .header-actions {
                display: flex;
                flex-grow: 1;
                justify-content: flex-end;
                min-width: 0;
                gap: 6px;
                align-items: center;
            }

            /* Section break inside a menu pop-up. The pop-up's content is a plain slot, so an <hr>
           lands between two runs of menu items with no vira support needed. */
            .menu-divider {
                border: none;
                border-top: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
                margin: 4px 0;
                width: 100%;
            }

            /* The theme switcher sits inside the options menu above the Settings item; give it breathing
           room so it doesn't crowd the menu edges or the item below it. */
            .theme-switcher-menu-row {
                display: flex;
                justify-content: center;
                padding: 8px 10px;
            }

            ${hostClasses['vir-sidebar-header-mobile'].selector} {
                padding: 12px 16px;

                /*
             * Loosen up spacing between the header action buttons on mobile — the buttons
             * themselves are bigger (ViraSize.Large, ~40px) and packed too tightly at the desktop
             * gap would still create thumb-spanning mis-taps between adjacent targets.
             */
                & .header-actions {
                    gap: 10px;
                }

                & .title {
                    font-size: 16px;
                }
            }
        `;
    },
    render({inputs, dispatch, events}) {
        /**
         * Mobile (where the sidebar lives inside `ViraModal` on small screens) uses the 40px-tall
         * `Large` button + 24px icon so the tap target sits closer to Apple HIG's 44px guideline.
         * The desktop docked sidebar keeps the compact 24px `Small` version where mouse precision
         * makes that fine.
         */
        const buttonSize = inputs.mobileModal ? ViraSize.Large : ViraSize.Small;

        return html`
            <span class="title">
                <${ViraIcon.assign({
                    icon: brandMarkIcon,
                })}></${ViraIcon}>
                ${inputs.heading || nothing}
            </span>
            <span class="header-actions">
                <${VirSidebarSearch.assign({
                    query: inputs.searchQuery,
                    hasResult: inputs.hasSearchResult,
                })}></${VirSidebarSearch}>
                <${ViraButton.assign({
                    icon: inputs.mobileModal ? mobilePlusIcon : LucidePlusIcon,
                    buttonSize,
                    color: ViraColorVariant.Positive,
                })}
                    ${tooltip('Add folder', sidebarTooltipOptions)}
                    ${listen('click', () => {
                        dispatch(
                            new events.addRepoRequest({
                                detail: undefined,
                            }),
                        );
                    })}
                ></${ViraButton}>
                <${ViraMenuTrigger}>
                    <${ViraButton.assign({
                        icon: inputs.mobileModal ? mobileFilterIcon : LucideListFilterIcon,
                        buttonSize,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        ${tooltip('Filter & group sidebar', sidebarTooltipOptions)}
                    ></${ViraButton}>
                    ${buildFilterMenuSections({
                        sidebarGrouping: inputs.sidebarGrouping,
                        sidebarSorting: inputs.sidebarSorting,
                        onlyShowRecent: inputs.onlyShowRecent,
                        onGroupingSelect(grouping) {
                            dispatch(
                                new events.groupingSelect({
                                    detail: grouping,
                                }),
                            );
                        },
                        onSortingSelect(sorting) {
                            dispatch(
                                new events.sortingSelect({
                                    detail: sorting,
                                }),
                            );
                        },
                        onHideInactiveChange(onlyShowRecent) {
                            dispatch(
                                new events.hideInactiveChange({
                                    detail: onlyShowRecent,
                                }),
                            );
                        },
                    }).map((section, index) => {
                        return html`
                            ${index
                                ? html`
                                      <hr class="menu-divider" />
                                  `
                                : nothing}
                            ${renderMenuItemEntries(section)}
                        `;
                    })}
                </${ViraMenuTrigger}>
                <${ViraMenuTrigger}>
                    <${ViraButton.assign({
                        icon: inputs.mobileModal ? mobileEllipsisIcon : LucideEllipsisIcon,
                        buttonSize,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                    })}
                        slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                        ${tooltip('More options', sidebarTooltipOptions)}
                    ></${ViraButton}>
                    <div class="theme-switcher-menu-row">
                        <${ViraThemeSwitcher.assign({
                            themeClient: inputs.themeClient,
                        })}></${ViraThemeSwitcher}>
                    </div>
                    ${renderMenuItemEntries([
                        {
                            content: 'Settings',
                            onClick() {
                                dispatch(
                                    new events.settingsRequest({
                                        detail: undefined,
                                    }),
                                );
                            },
                        },
                    ])}
                </${ViraMenuTrigger}>
            </span>
        `;
    },
});
