import {type AppContext, defineAppElement} from '@agent-storm/core/frontend';
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
import {VirMainTabs} from './vir-main-tabs.element.js';

/**
 * Mobile's stand-in for the docked tab strip and sidebar: a hamburger button that opens them in a
 * modal, beside a gear button that opens Settings. Picking a folder or pull request, or opening
 * Settings, closes the modal.
 */
export const VirMobileSidebar = defineAppElement<{
    context: AppContext;
    /** The activity the route selects. */
    activityId: string;
    /** The route's segments after `activityId`. */
    subPaths: ReadonlyArray<string>;
}>()({
    tagName: 'vir-mobile-sidebar',
    state() {
        return {
            isOpen: false,
            /** Activities shown so far, so each sidebar only loads once it's needed. */
            shownActivityIds: [] as ReadonlyArray<string>,
        };
    },
    styles: css`
        :host {
            display: inline-flex;
            gap: 16px;
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
        const activityId = inputs.activityId;
        if (!state.shownActivityIds.includes(activityId)) {
            updateState({
                shownActivityIds: [
                    ...state.shownActivityIds,
                    activityId,
                ],
            });
        }
        const title =
            inputs.context.activities.find((activity) => activity.id === activityId)
                ?.mobileMenuTitle || '';

        function close() {
            updateState({
                isOpen: false,
            });
        }

        /** Selecting anything in the modal, or opening Settings from it, closes it. */
        const context: AppContext = {
            ...inputs.context,
            navigate(paths) {
                close();
                inputs.context.navigate(paths);
            },
            openSettings(target) {
                close();
                inputs.context.openSettings(target);
            },
        };

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
                    inputs.context.openSettings(undefined);
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
                <div class="content">
                    <${VirMainTabs.assign({
                        context,
                        activityId,
                        isHorizontal: true,
                    })}></${VirMainTabs}>
                    ${context.activities.map((activity) => {
                        const isCurrent = activity.id === activityId;
                        if (
                            !activity.sidebar ||
                            !(isCurrent || state.shownActivityIds.includes(activity.id))
                        ) {
                            return nothing;
                        }
                        return html`
                            <div class="sidebar" ?data-hidden=${!isCurrent}>
                                ${activity.sidebar.render({
                                    context,
                                    state: context.activityStates[activity.id],
                                    route: {
                                        subPaths: isCurrent ? inputs.subPaths : [],
                                        navigate(subPaths) {
                                            context.navigate([
                                                activity.id,
                                                ...subPaths,
                                            ]);
                                        },
                                    },
                                })}
                            </div>
                        `;
                    })}
                </div>
            </${ViraModal}>
        `;
    },
});
