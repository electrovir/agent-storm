import {SidebarSorting} from '@agent-storm/common';
import {
    defineAppElement,
    sidebarSortingLabels,
    sidebarTooltipOptions,
    VirSidebarSearch,
} from '@agent-storm/core/frontend';
import {getObjectTypedKeys} from '@augment-vir/common';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    createSizedIcon,
    LucideCheckIcon,
    LucideEllipsisIcon,
    LucideListFilterIcon,
    LucidePlusIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    type ViraThemeClient,
    ViraThemeSwitcher,
} from 'vira';

/** Paired with `ViraSize.Large` so mobile tap targets land near Apple's recommended 44px. */
const mobileButtonIconSize = 24;
const mobilePlusIcon = createSizedIcon(LucidePlusIcon, mobileButtonIconSize);
const mobileEllipsisIcon = createSizedIcon(LucideEllipsisIcon, mobileButtonIconSize);
const mobileFilterIcon = createSizedIcon(LucideListFilterIcon, mobileButtonIconSize);

/**
 * The Build sidebar's top bar: search, add-folder button, and the filter and options menus. The
 * search's events bubble out of it unchanged.
 */
export const VirBuildSidebarHeader = defineAppElement<{
    mobileModal: boolean;
    searchQuery: string;
    /** Whether Enter in the search input has a row to open. */
    hasSearchResult: boolean;
    sidebarSorting: SidebarSorting | undefined;
    onlyShowRecent: boolean | undefined;
    showArchived: boolean;
    themeClient: Readonly<ViraThemeClient>;
}>()({
    tagName: 'vir-build-sidebar-header',
    events: {
        addFolderRequest: defineElementEvent<void>(),
        sortingSelect: defineElementEvent<SidebarSorting>(),
        hideInactiveChange: defineElementEvent<boolean>(),
        showArchivedChange: defineElementEvent<boolean>(),
        settingsRequest: defineElementEvent<void>(),
    },
    hostClasses: {
        'vir-build-sidebar-header-mobile'({inputs}) {
            return inputs.mobileModal;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: flex;
                flex-shrink: 0;
                align-items: center;
                justify-content: space-between;
                padding: 8px 5px;
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
                gap: 6px;
            }

            .header-actions {
                display: flex;
                flex-grow: 1;
                justify-content: flex-end;
                min-width: 0;
                gap: 6px;
                align-items: center;
            }

            .menu-divider {
                border: none;
                border-top: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
                margin: 4px 0;
                width: 100%;
            }

            .theme-switcher-menu-row {
                display: flex;
                justify-content: center;
                padding: 8px 10px;
            }

            ${hostClasses['vir-build-sidebar-header-mobile'].selector} {
                padding: 12px 16px;

                & .header-actions {
                    gap: 10px;
                }
            }
        `;
    },
    render({inputs, dispatch, events}) {
        const buttonSize = inputs.mobileModal ? ViraSize.Large : ViraSize.Small;
        const selectedSorting = inputs.sidebarSorting ?? SidebarSorting.Name;

        return html`
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
                            new events.addFolderRequest({
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
                        ${tooltip('Filter & sort sidebar', sidebarTooltipOptions)}
                    ></${ViraButton}>
                    ${renderMenuItemEntries(
                        getObjectTypedKeys(sidebarSortingLabels).map((sorting) => {
                            return {
                                content: sidebarSortingLabels[sorting],
                                iconOverride:
                                    selectedSorting === sorting ? LucideCheckIcon : undefined,
                                onClick() {
                                    if (selectedSorting !== sorting) {
                                        dispatch(
                                            new events.sortingSelect({
                                                detail: sorting,
                                            }),
                                        );
                                    }
                                },
                            };
                        }),
                    )}
                    <hr class="menu-divider" />
                    ${renderMenuItemEntries([
                        {
                            content: 'Hide Inactive',
                            iconOverride: inputs.onlyShowRecent ? LucideCheckIcon : undefined,
                            onClick() {
                                dispatch(
                                    new events.hideInactiveChange({
                                        detail: !inputs.onlyShowRecent,
                                    }),
                                );
                            },
                        },
                        {
                            content: 'Show Archived',
                            iconOverride: inputs.showArchived ? LucideCheckIcon : undefined,
                            onClick() {
                                dispatch(
                                    new events.showArchivedChange({
                                        detail: !inputs.showArchived,
                                    }),
                                );
                            },
                        },
                    ])}
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
