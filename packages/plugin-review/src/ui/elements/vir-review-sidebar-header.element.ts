import {
    defineAppElement,
    sidebarTooltipOptions,
    spinAnimationCss,
    spinKeyframesCss,
    VirSidebarSearch,
} from '@agent-storm/core/frontend';
import {getObjectTypedValues} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideLoaderIcon,
    LucideRotateCwIcon,
    noUserSelect,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {PrQueueKind} from '../../util/pr-queues.js';
import {prQueueTabs, type ReviewSidebarQueues} from './review-sidebar-display.js';
import {VirReviewSidebarSettingsMenu} from './vir-review-sidebar-settings-menu.element.js';

/** Same tap-target sizing as the Build sidebar's mobile header buttons. */
const mobileRefreshIcon = createSizedIcon(LucideRotateCwIcon, 24);

/**
 * The Review sidebar's search, refresh status, and list tabs. The search's events and its settings
 * menu's `settingsRequested` event bubble out unchanged.
 */
export const VirReviewSidebarHeader = defineAppElement<{
    queues: ReviewSidebarQueues | undefined;
    /** Already resolved against `fixedQueue`. */
    selectedQueue: PrQueueKind;
    /** Shows only this list's label in place of the list tabs. */
    fixedQueue?: PrQueueKind | undefined;
    mobileModal?: boolean | undefined;
    searchQuery: string;
    /** Whether Enter in the search input has a PR to open. */
    hasSearchResult: boolean;
}>()({
    tagName: 'vir-review-sidebar-header',
    events: {
        refreshRequested: defineElementEvent<PrQueueKind>(),
        queueSelected: defineElementEvent<PrQueueKind>(),
    },
    styles: css`
        :host {
            display: block;
        }

        ${spinKeyframesCss}

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 5px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            &[data-mobile] {
                padding: 12px 16px;
            }
        }

        .title {
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
        }

        .updates {
            display: flex;
            flex-grow: 1;
            justify-content: flex-end;
            min-width: 0;
            align-items: center;
            gap: 4px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            & > ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        .queue-tabs {
            display: flex;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .queue-tab {
            ${noUserSelect};
            appearance: none;
            background: transparent;
            border: none;
            border-bottom: 2px solid transparent;
            flex-grow: 1;
            padding: 8px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;

            &:hover {
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &[data-selected] {
                color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
                border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }

            &[data-mobile] {
                padding: 12px 8px;
            }
        }
    `,
    render({inputs, dispatch, events}) {
        const shownQueue = inputs.queues?.[inputs.selectedQueue].queue;
        const isUpdating = !!shownQueue?.isUpdating;

        function renderQueueLabel(kind: PrQueueKind) {
            const queue = inputs.queues?.[kind].queue;
            return html`
                ${prQueueTabs[kind].label}
                ${queue?.updatedAt ? `(${queue.pullRequests.length})` : nothing}
            `;
        }

        const tabsTemplate = inputs.fixedQueue
            ? nothing
            : html`
                  <div class="queue-tabs" role="tablist">
                      ${getObjectTypedValues(PrQueueKind).map((kind) => {
                          const isSelected = kind === inputs.selectedQueue;
                          return html`
                              <button
                                  type="button"
                                  class="queue-tab"
                                  role="tab"
                                  ?data-selected=${isSelected}
                                  ?data-mobile=${inputs.mobileModal}
                                  aria-selected=${isSelected}
                                  ${listen('click', () => {
                                      dispatch(
                                          new events.queueSelected({
                                              detail: kind,
                                          }),
                                      );
                                  })}
                              >
                                  ${renderQueueLabel(kind)}
                              </button>
                          `;
                      })}
                  </div>
              `;

        return html`
            <div class="header" ?data-mobile=${inputs.mobileModal}>
                ${inputs.fixedQueue
                    ? html`
                          <span class="title">${renderQueueLabel(inputs.fixedQueue)}</span>
                      `
                    : nothing}
                <span class="updates">
                    <${VirSidebarSearch.assign({
                        query: inputs.searchQuery,
                        hasResult: inputs.hasSearchResult,
                    })}></${VirSidebarSearch}>
                    ${isUpdating
                        ? html`
                              <${ViraIcon.assign({
                                  icon: LucideLoaderIcon,
                              })}></${ViraIcon}>
                          `
                        : nothing}
                    <${ViraButton.assign({
                        icon: inputs.mobileModal ? mobileRefreshIcon : LucideRotateCwIcon,
                        buttonSize: inputs.mobileModal ? ViraSize.Large : ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        isDisabled: isUpdating,
                    })}
                        ${tooltip('Refresh now.', sidebarTooltipOptions)}
                        ${listen('click', () => {
                            if (isUpdating) {
                                return;
                            }
                            dispatch(
                                new events.refreshRequested({
                                    detail: inputs.selectedQueue,
                                }),
                            );
                        })}
                    ></${ViraButton}>
                    <${VirReviewSidebarSettingsMenu.assign({
                        menuTitle: 'Review actions',
                        repo: undefined,
                        mobileModal: inputs.mobileModal,
                    })}></${VirReviewSidebarSettingsMenu}>
                </span>
            </div>
            ${tabsTemplate}
        `;
    },
});
