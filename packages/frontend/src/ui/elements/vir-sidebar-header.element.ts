import {type SidebarGrouping, type SidebarSorting} from '@agent-storm/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideEllipsisIcon,
    LucideListFilterIcon,
    LucidePlusIcon,
    LucideSearchIcon,
    type PopoverManager,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    viraFormCssVars,
    ViraIcon,
    ViraInput,
    ViraMenuTrigger,
    ViraPopoverTrigger,
    viraShadows,
    ViraSize,
    viraThemeByKeys,
    type ViraThemeClient,
    ViraThemeSwitcher,
} from 'vira';
import {sidebarTooltipOptions} from '../../util/sidebar-display.js';
import {defineAppElement} from '../define-app-element.js';
import {AgentStormMarkIcon} from '../icons/agent-storm-mark.icon.js';
import {buildFilterMenuSections} from './sidebar-menus.js';

const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

/**
 * Larger icon variants for the mobile sidebar modal's header buttons. Paired with `ViraSize.Large`
 * so the tap targets land near Apple's HIG-recommended 44px, which the previous `ViraSize.Small` +
 * 16px-icon combo (24px tall) was well short of.
 */
const mobileButtonIconSize = 24;
const mobileSearchIcon = createSizedIcon(LucideSearchIcon, mobileButtonIconSize);
const mobilePlusIcon = createSizedIcon(LucidePlusIcon, mobileButtonIconSize);
const mobileEllipsisIcon = createSizedIcon(LucideEllipsisIcon, mobileButtonIconSize);
const mobileFilterIcon = createSizedIcon(LucideListFilterIcon, mobileButtonIconSize);

/** The sidebar's top bar: brand, search pop-up, add-repo button, and the filter and options menus. */
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
        searchQueryChange: defineElementEvent<string>(),
        /** Enter in the search input, only fired while `hasSearchResult` is set. */
        searchSubmit: defineElementEvent<void>(),
        addRepoRequest: defineElementEvent<void>(),
        groupingSelect: defineElementEvent<SidebarGrouping>(),
        sortingSelect: defineElementEvent<SidebarSorting>(),
        hideInactiveChange: defineElementEvent<boolean>(),
        defineAiRequest: defineElementEvent<void>(),
        settingsRequest: defineElementEvent<void>(),
    },
    state() {
        return {
            /**
             * The search pop-up's own manager, grabbed from its `init` event. `ViraPopoverTrigger`
             * has no `open` input, so this is the only way to close the pop-up from the outside —
             * needed when Enter in the search input activates the top result.
             */
            searchPopoverManager: undefined as PopoverManager | undefined,
        };
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

            .header-actions {
                display: flex;
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

            /* Card behind the search input so the pop-up reads as a panel, not a bare floating input.
           Mirrors vira's own menu pop-up surface (background/border/radius/shadow). */
            .search-popup {
                padding: 10px;
                min-width: 220px;
                box-sizing: border-box;
                background-color: ${viraFormCssVars['vira-form-background-color'].value};
                color: ${viraFormCssVars['vira-form-foreground-color'].value};
                border: 1px solid ${viraFormCssVars['vira-form-border-color'].value};
                border-radius: ${viraFormCssVars['vira-form-radius'].value};
                ${viraShadows.menuShadow}
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
    render({inputs, state, updateState, host, dispatch, events}) {
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
                <${ViraPopoverTrigger.assign({
                    keepOpenAfterInteraction: true,
                })}
                    ${listen(ViraPopoverTrigger.events.openChange, (event) => {
                        if (event.detail) {
                            focusSearchInput(host);
                        }
                    })}
                    ${listen(ViraPopoverTrigger.events.init, (event) => {
                        updateState({
                            searchPopoverManager: event.detail.popoverManager,
                        });
                    })}
                >
                    <${ViraButton.assign({
                        icon: inputs.mobileModal ? mobileSearchIcon : LucideSearchIcon,
                        buttonSize,
                        /**
                         * Bump the search button to Standard emphasis while a search is active so
                         * it stays visibly "on" after the pop-up closes — the query persists past
                         * close, so the filter is still applied even with the pop-up shut.
                         */
                        buttonEmphasis: inputs.searchQuery.trim()
                            ? ViraEmphasis.Standard
                            : ViraEmphasis.Subtle,
                        color: ViraColorVariant.Plain,
                    })}
                        slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-trigger']}
                        ${tooltip('Search repos & worktrees', sidebarTooltipOptions)}
                    ></${ViraButton}>
                    <div
                        class="search-popup"
                        slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-popover']}
                    >
                        <${ViraInput.assign({
                            value: inputs.searchQuery,
                            placeholder: 'Search repos & worktrees',
                            showClearButton: true,
                        })}
                            class="search-input"
                            ${listen(ViraInput.events.valueChange, (event) => {
                                dispatch(
                                    new events.searchQueryChange({
                                        detail: event.detail,
                                    }),
                                );
                            })}
                            ${listen('keydown', (event) => {
                                if (
                                    !(event instanceof KeyboardEvent) ||
                                    event.key !== 'Enter' ||
                                    !inputs.hasSearchResult
                                ) {
                                    return;
                                }
                                dispatch(
                                    new events.searchSubmit({
                                        detail: undefined,
                                    }),
                                );
                                /**
                                 * `keepOpenAfterInteraction` means picking a result won't close the
                                 * pop-up on its own, and leaving it floating over a sidebar that
                                 * just jumped to the new folder is disorienting.
                                 */
                                state.searchPopoverManager?.hide();
                            })}
                        ></${ViraInput}>
                    </div>
                </${ViraPopoverTrigger}>
                <${ViraButton.assign({
                    icon: inputs.mobileModal ? mobilePlusIcon : LucidePlusIcon,
                    buttonSize,
                    color: ViraColorVariant.Positive,
                })}
                    ${tooltip('Add new repository.', sidebarTooltipOptions)}
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
                            content: 'Define AI',
                            onClick() {
                                dispatch(
                                    new events.defineAiRequest({
                                        detail: undefined,
                                    }),
                                );
                            },
                        },
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

/**
 * Focuses the native input inside the search pop-up once it opens. The pop-up content is slotted
 * into this element's shadow root, and `ViraInput` keeps its real `<input>` in its own shadow root,
 * so we reach through both. Deferred a frame because the pop-up manager mounts/positions the
 * element after `openChange` fires — focusing synchronously would target a not-yet-visible node.
 */
function focusSearchInput(host: HTMLElement): void {
    requestAnimationFrame(() => {
        const searchInput = host.shadowRoot?.querySelector('.search-input');
        const nativeInput = searchInput?.shadowRoot?.querySelector('input');
        if (nativeInput instanceof HTMLInputElement) {
            nativeInput.focus();
        }
    });
}
