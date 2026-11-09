// cspell:words meslo menlo

import {type ReviewQueuePr} from '@agent-storm/common';
import {
    defineAppElement,
    prStatusIcons,
    renderPaneChip,
    sidebarContextMenuOffset,
    sidebarTooltipOptions,
    spinAnimationCss,
    spinKeyframesCss,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, nothing, unsafeHTML} from 'element-vir';
import {
    LucideRotateCwIcon,
    PopoverAnchor,
    PopoverTrigger,
    renderMenuItemEntries,
    tooltip,
    ViraIcon,
    ViraLink,
    ViraMenuTrigger,
    viraThemeByKeys,
} from 'vira';
import {sanitizeGitHubHtml} from '../../util/github-markdown.js';
import {type PrQueueKind} from '../../util/pr-queues.js';
import {queuePrStatusDisplays} from './review-sidebar-display.js';

/** One pull request in the Review sidebar, with its pane chips, assignees, status, and menu. */
export const VirReviewSidebarRow = defineAppElement<{
    pr: Readonly<ReviewQueuePr>;
    /** Decides which statuses get an icon and what their tooltips say. */
    queueKind: PrQueueKind;
    isActive: boolean;
    canRestartPanes: boolean;
    mobileModal?: boolean | undefined;
}>()({
    tagName: 'vir-review-sidebar-row',
    events: {
        rowClicked: defineElementEvent<ReviewQueuePr>(),
        restartPanesRequested: defineElementEvent<ReviewQueuePr>(),
    },
    state() {
        return {
            isMenuOpen: false,
        };
    },
    styles: css`
        :host {
            display: block;
        }

        ${spinKeyframesCss}

        /* A menu trigger is inline by default, which would shrink the row to its content. */
        ${ViraMenuTrigger} {
            display: flex;
        }

        /* The menu trigger wraps the row in a button, which centers its text. */
        .row {
            flex-grow: 1;
            text-align: start;
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 0 5px 0 0;
            cursor: pointer;
            user-select: none;

            &:hover,
            &[data-menu-open] {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }

            &[data-active] {
                background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background
                    .value};
            }

            &[data-draft] {
                opacity: 0.5;
            }

            &[data-mobile] {
                min-height: 34px;
                padding: 4px 16px 4px 30px;
            }
        }

        .chain-connector {
            align-self: flex-start;
            flex-shrink: 0;
            width: 8px;
            height: 0.7em;
            border-left: 1px solid ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            border-bottom: 1px solid ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .avatars,
        .chips {
            display: flex;
            align-items: center;
            align-self: flex-start;
            flex-shrink: 0;
            height: 1lh;
            padding-top: 2px;
        }

        /* Pulls the avatars in closer than the row's gap allows. */
        .chips {
            margin-right: -4px;
        }

        .chip {
            width: 12px;
            height: 12px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }

        .chip[data-busy] ${ViraIcon} {
            ${spinAnimationCss}
        }

        .pr-status {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .avatar {
            width: 16px;
            height: 16px;
            border-radius: 50%;

            & + & {
                margin-left: -4px;
            }
        }

        .name {
            flex-grow: 1;
            min-width: 0;
            overflow-wrap: anywhere;
            padding: 2px 0;

            /* The title is one line of markdown, so only its inline code needs styling. */
            & code {
                padding: 0 3px;
                border-radius: 3px;
                font-family: 'MesloLGS NF', Menlo, monospace;
                font-size: 0.85em;
                ${colorCss(viraThemeByKeys.grey['behind-fg']['small-body'])};
            }
        }

        .row[data-mobile] .name {
            padding: 4px 0;
        }

        .row[data-mobile] .avatars,
        .row[data-mobile] .chips {
            padding-top: 4px;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const statusDisplay = queuePrStatusDisplays[inputs.queueKind];
        const statusIcon = statusDisplay.shownStatuses.includes(inputs.pr.prStatus)
            ? prStatusIcons[inputs.pr.prStatus]
            : undefined;

        return html`
            <${ViraMenuTrigger.assign({
                trigger: PopoverTrigger.ContextMenu,
                popoverAnchor: PopoverAnchor.Mouse,
                popoverOffset: sidebarContextMenuOffset,
            })}
                ${listen(ViraMenuTrigger.events.openChange, (event) => {
                    updateState({
                        isMenuOpen: event.detail,
                    });
                })}
            >
                <div
                    class="row"
                    slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                    ?data-active=${inputs.isActive}
                    ?data-draft=${inputs.pr.isDraft}
                    ?data-menu-open=${state.isMenuOpen}
                    ?data-mobile=${inputs.mobileModal}
                    ${listen('click', () => {
                        dispatch(
                            new events.rowClicked({
                                detail: inputs.pr,
                            }),
                        );
                    })}
                >
                    <span class="chips">${renderPaneChip('AI', inputs.pr.panes.ai)}</span>
                    ${inputs.pr.chainDepth
                        ? html`
                              <span class="chain-connector"></span>
                          `
                        : nothing}
                    <span class="avatars">
                        ${inputs.pr.assignees.map((assignee) => {
                            return html`
                                <img
                                    class="avatar"
                                    src=${assignee.avatarUrl}
                                    alt=${assignee.login}
                                    ${tooltip(assignee.login, sidebarTooltipOptions)}
                                />
                            `;
                        })}
                    </span>
                    <span class="name">
                        ${inputs.pr.titleHtml
                            ? unsafeHTML(sanitizeGitHubHtml(inputs.pr.titleHtml))
                            : inputs.pr.title}
                    </span>
                    ${statusIcon
                        ? html`
                              <span
                                  class="pr-status"
                                  ${tooltip(
                                      statusDisplay.tooltips[inputs.pr.prStatus],
                                      sidebarTooltipOptions,
                                  )}
                              >
                                  <${ViraIcon.assign({
                                      icon: statusIcon,
                                  })}></${ViraIcon}>
                              </span>
                          `
                        : nothing}
                </div>
                ${renderMenuItemEntries(
                    [
                        {
                            content: html`
                                <${ViraLink.assign({
                                    link: {
                                        url: inputs.pr.url,
                                        newTab: true,
                                    },
                                    disableLinkStyles: true,
                                })}>
                                    Open PR
                                </${ViraLink}>
                            `,
                        },
                        /** The viewer's own PRs open on GitHub, so they have no panes. */
                        inputs.canRestartPanes &&
                            !inputs.pr.isViewerAuthor && {
                                content: 'Restart panes',
                                iconOverride: LucideRotateCwIcon,
                                onClick() {
                                    dispatch(
                                        new events.restartPanesRequested({
                                            detail: inputs.pr,
                                        }),
                                    );
                                },
                            },
                    ].filter(check.isTruthy),
                )}
            </${ViraMenuTrigger}>
        `;
    },
});
