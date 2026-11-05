import {css, html, listen, nothing} from 'element-vir';
import {
    LucideMenuIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraModal,
    ViraSize,
} from 'vira';
import {type AppContext} from '../../util/app-context.js';
import {MainTab} from '../../util/router.js';
import {defineAppElement} from '../define-app-element.js';
import {VirBuildSidebar} from './vir-build-sidebar.element.js';
import {VirMainTabs} from './vir-main-tabs.element.js';
import {VirReviewQueueSidebar} from './vir-review-queue-sidebar.element.js';
import {VirReviewSidebar} from './vir-review-sidebar.element.js';
import {VirSidebar} from './vir-sidebar.element.js';

const mobileSidebarTitles: Record<MainTab, string> = {
    [MainTab.Dashboard]: 'Dashboard',
    [MainTab.Build]: 'Repos',
    [MainTab.Review]: 'Review requests',
    [MainTab.Debug]: 'Debug',
};

/**
 * Mobile's stand-in for the docked tab strip and sidebar: a hamburger button that opens them in a
 * modal. Picking a folder or pull request, or opening the AI modal, closes it.
 */
export const VirMobileSidebar = defineAppElement<{
    context: AppContext;
}>()({
    tagName: 'vir-mobile-sidebar',
    state() {
        return {
            isOpen: false,
            /** Set once the Review tab shows, so the review lists only load once they're needed. */
            hasShownReview: false,
        };
    },
    styles: css`
        :host {
            display: inline-flex;
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

        ${VirBuildSidebar}, ${VirReviewQueueSidebar} {
            width: 100%;
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            min-height: 0;
        }

        /* Hidden rather than unmounted, so switching tabs keeps each list's scroll position. */
        [data-hidden] {
            display: none;
        }
    `,
    render({inputs, state, updateState}) {
        const mainTab = inputs.context.resolved.mainTab;
        if (mainTab === MainTab.Review && !state.hasShownReview) {
            updateState({
                hasShownReview: true,
            });
        }

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
                ${tooltip(`Open ${mobileSidebarTitles[mainTab].toLowerCase()}`)}
                ${listen('click', () => {
                    updateState({
                        isOpen: true,
                    });
                })}
            ></${ViraButton}>
            <${ViraModal.assign({
                open: state.isOpen,
                modalTitle: mobileSidebarTitles[mainTab],
                isMobileSize: true,
                noContentPadding: true,
            })}
                ${listen(ViraModal.events.modalClose, close)}
            >
                <div
                    class="content"
                    ${listen(VirSidebar.events.folderActivated, close)}
                    ${listen(VirSidebar.events.openAiModalRequested, close)}
                    ${listen(VirReviewSidebar.events.pullRequestActivated, close)}
                >
                    <${VirMainTabs.assign({
                        context: inputs.context,
                        isHorizontal: true,
                    })}></${VirMainTabs}>
                    ${mainTab === MainTab.Review || state.hasShownReview
                        ? html`
                              <${VirReviewQueueSidebar.assign({
                                  context: inputs.context,
                              })}
                                  ?data-hidden=${mainTab !== MainTab.Review}
                              ></${VirReviewQueueSidebar}>
                          `
                        : nothing}
                    <${VirBuildSidebar.assign({
                        context: inputs.context,
                    })}
                        ?data-hidden=${mainTab !== MainTab.Build}
                    ></${VirBuildSidebar}>
                </div>
            </${ViraModal}>
        `;
    },
});
