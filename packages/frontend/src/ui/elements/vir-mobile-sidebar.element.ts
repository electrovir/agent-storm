import {getEnumValues} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {
    LucideMenuIcon,
    LucideSettingsIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraModal,
    ViraSize,
} from 'vira';
import {SettingsSection, type AppContext} from '../../util/app-context.js';
import {ActivityId} from '../../util/router.js';
import {defineAppElement} from '../define-app-element.js';
import {activityDefinitions} from './activity-definitions.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirReviewSidebar} from './vir-review-sidebar.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

/**
 * Mobile's stand-in for the docked tab strip and sidebar: a hamburger button that opens them in a
 * modal, beside a gear button that opens Settings. Picking a folder or pull request, or opening
 * Settings, closes the modal.
 */
export const VirMobileSidebar = defineAppElement<{
    context: AppContext;
}>()({
    tagName: 'vir-mobile-sidebar',
    state() {
        return {
            isOpen: false,
            /** Activities shown so far, so each sidebar only loads once it's needed. */
            shownActivityIds: [] as ReadonlyArray<ActivityId>,
        };
    },
    styles: css`
        :host {
            display: inline-flex;
            gap: 4px;
            position: absolute;
            top: 6px;
            left: 6px;
            z-index: 2;
        }

        /*
         * ViraModal's body slot is content-sized (no defined height), so we hand it explicit
         * dimensions here. Height clamps to a viewport-fraction so the sidebar's flex children
         * (header + scrollable list) have something to grow into instead of collapsing to 0.
         */
        .content {
            width: 100%;
            height: 70dvh;
            max-height: 600px;
            display: flex;
            flex-direction: column;
        }

        .sidebar {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-height: 0;

            & > * {
                flex-grow: 1;
                min-width: 0;
                min-height: 0;
            }
        }

        /* Hidden rather than unmounted, so switching tabs keeps each list's scroll position. */
        [data-hidden] {
            display: none;
        }
    `,
    render({inputs, state, updateState}) {
        const activityId = inputs.context.resolved.activityId;
        if (!state.shownActivityIds.includes(activityId)) {
            updateState({
                shownActivityIds: [
                    ...state.shownActivityIds,
                    activityId,
                ],
            });
        }
        const title = activityDefinitions[activityId].mobileMenuTitle || '';

        function close() {
            updateState({
                isOpen: false,
            });
        }

        return html`
            <${ViraButton.assign({
                icon: LucideMenuIcon,
                buttonSize: ViraSize.Small,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Neutral,
            })}
                ${tooltip(`Open ${title.toLowerCase()}`)}
                ${listen('click', () => {
                    updateState({
                        isOpen: true,
                    });
                })}
            ></${ViraButton}>
            <${ViraButton.assign({
                icon: LucideSettingsIcon,
                buttonSize: ViraSize.Small,
                buttonEmphasis: ViraEmphasis.Subtle,
                color: ViraColorVariant.Neutral,
            })}
                ${tooltip('Open settings')}
                ${listen('click', () => {
                    inputs.context.settingsTarget.setValue({
                        section: SettingsSection.General,
                    });
                })}
            ></${ViraButton}>
            <${ViraModal.assign({
                open: state.isOpen,
                modalTitle: title,
                isMobileSize: true,
                noContentPadding: true,
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                <div
                    class="content"
                    ${listen(VirSidebar.events.folderActivated, close)}
                    ${listen(VirSidebar.events.openSettingsRequested, close)}
                    ${listen(VirReviewSidebar.events.pullRequestActivated, close)}
                    ${listen(VirReviewSidebar.events.settingsRequested, close)}
                >
                    <${VirMainTabs.assign({
                        context: inputs.context,
                        isHorizontal: true,
                    })}></${VirMainTabs}>
                    ${getEnumValues(ActivityId).map((sidebarActivityId) => {
                        const sidebar = activityDefinitions[sidebarActivityId].sidebar;
                        if (
                            !sidebar ||
                            !(
                                sidebarActivityId === activityId ||
                                state.shownActivityIds.includes(sidebarActivityId)
                            )
                        ) {
                            return nothing;
                        }
                        return html`
                            <div class="sidebar" ?data-hidden=${sidebarActivityId !== activityId}>
                                ${sidebar.render(inputs.context)}
                            </div>
                        `;
                    })}
                </div>
            </${ViraModal}>
        `;
    },
});
