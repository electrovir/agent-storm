import {getObjectTypedValues} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
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
import {PrQueueKind} from '../../util/frontend-state.js';
import {compactAge} from '../../util/relative-time.js';
import {sidebarTooltipOptions} from '../../util/sidebar-display.js';
import {defineAppElement} from '../define-app-element.js';
import {AgentStormMarkIcon} from '../icons/agent-storm-mark.icon.js';
import {prQueueTabs, type ReviewSidebarQueues} from './review-sidebar-display.js';
import {spinAnimationCss, spinKeyframesCss} from './spin-styles.js';
import {VirReviewSidebarSettingsMenu} from './vir-review-sidebar-settings-menu.element.js';

/** Same tap-target sizing as the Build sidebar's mobile header buttons. */
const mobileRefreshIcon = createSizedIcon(LucideRotateCwIcon, 24);
const brandMarkIcon = createSizedIcon(AgentStormMarkIcon, 16);

/**
 * The Review sidebar's brand row, refresh status, and list tabs. Its settings menu's
 * `settingsRequested` event bubbles out unchanged.
 */
export const VirReviewSidebarHeader = defineAppElement<{
    queues: ReviewSidebarQueues | undefined;
    /** Already resolved against `fixedQueue`. */
    selectedQueue: PrQueueKind;
    /** Shows only this list's label beside the brand mark in place of the list tabs. */
    fixedQueue?: PrQueueKind | undefined;
    mobileModal?: boolean | undefined;
}>()({
    tagName: 'vir-review-sidebar-header',
    events: {
        refreshRequested: defineElementEvent<PrQueueKind>(),
        queueSelected: defineElementEvent<PrQueueKind>(),
    },
    state() {
        return {
            /** Re-rendered on an interval so the queue's age label keeps counting up. */
            now: Date.now(),
            nowInterval: undefined as ReturnType<typeof setInterval> | undefined,
        };
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
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
            color: ${viraThemeByKeys.grey.foreground.header.foreground.value};
        }

        .updates {
            display: flex;
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
    init({updateState}) {
        updateState({
            nowInterval: setInterval(
                () => {
                    updateState({
                        now: Date.now(),
                    });
                },
                convertDuration(
                    {
                        minutes: 1,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
    },
    cleanup({state}) {
        clearInterval(state.nowInterval);
    },
    render({inputs, state, dispatch, events}) {
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
                <span class="title">
                    <${ViraIcon.assign({
                        icon: brandMarkIcon,
                    })}></${ViraIcon}>
                    ${inputs.fixedQueue ? renderQueueLabel(inputs.fixedQueue) : nothing}
                </span>
                <span class="updates">
                    ${isUpdating
                        ? html`
                              <${ViraIcon.assign({
                                  icon: LucideLoaderIcon,
                              })}></${ViraIcon}>
                          `
                        : nothing}
                    ${shownQueue?.updatedAt
                        ? html`
                              <span>
                                  ${compactAge({
                                      timestamp: shownQueue.updatedAt,
                                      now: state.now,
                                  })}
                              </span>
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
