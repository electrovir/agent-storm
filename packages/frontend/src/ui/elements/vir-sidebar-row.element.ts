import {type FolderInfo, PrStatus, WatchModeStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createColoredIcon,
    createSizedIcon,
    LucideEllipsisIcon,
    LucideEyeIcon,
    LucideEyeOffIcon,
    renderMenuItemEntries,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraIcon,
    type ViraIconSvg,
    ViraMenuTrigger,
    ViraSize,
    viraThemeByKeys,
    ViraThemeColorName,
} from 'vira';
import {FrontendTab} from '../../util/frontend-tab.js';
import {localStorageClient} from '../../util/local-storage-client.js';
import {
    localChangesIcon,
    localChangesTooltip,
    prStatusIcons,
    prStatusTooltips,
    renderPaneChip,
    sidebarTooltipOptions,
} from '../../util/sidebar-display.js';
import {defineAppElement} from '../define-app-element.js';
import {sidebarFolderMenuStyles} from './sidebar-menu-styles.js';
import {buildRowMenuEntries, type SidebarFolderAction} from './sidebar-menus.js';
import {spinAnimationCss, spinKeyframesCss} from './spin-styles.js';

function createWatchModeIcon(icon: Readonly<ViraIconSvg>, color: ViraThemeColorName) {
    return createColoredIcon(createSizedIcon(icon, 14), {
        'vira-icon-stroke-color': viraThemeByKeys[color].foreground.header.foreground.value,
    });
}

const watchModeIcons: Record<WatchModeStatus, ViraIconSvg> = {
    /** Only shown when watch mode stopped on its own, so its message says why. */
    [WatchModeStatus.Off]: createWatchModeIcon(LucideEyeOffIcon, ViraThemeColorName.grey),
    [WatchModeStatus.Watching]: createWatchModeIcon(LucideEyeIcon, ViraThemeColorName.grey),
    [WatchModeStatus.Working]: createWatchModeIcon(LucideEyeIcon, ViraThemeColorName.blue),
    [WatchModeStatus.Paused]: createWatchModeIcon(LucideEyeIcon, ViraThemeColorName.yellow),
};

const finishedPrStatuses: ReadonlyArray<PrStatus> = [
    PrStatus.Merged,
    PrStatus.Closed,
];

/**
 * One folder in the sidebar list. It holds no state, since reordering the list moves (and so
 * resets) rows; the sidebar runs every menu action, so an action that removes this row still
 * finishes.
 */
export const VirSidebarRow = defineAppElement<{
    folder: FolderInfo;
    isActive: boolean;
    isIndented: boolean;
    isMenuOpen: boolean;
    mobileModal: boolean | undefined;
}>()({
    tagName: 'vir-sidebar-row',
    events: {
        activate: defineElementEvent<void>(),
        menuOpenChange: defineElementEvent<boolean>(),
        actionSelect: defineElementEvent<SidebarFolderAction>(),
    },
    hostClasses: {
        'vir-sidebar-row-mobile'({inputs}) {
            return !!inputs.mobileModal;
        },
    },
    styles({hostClasses}) {
        return css`
            :host {
                display: block;
            }

            ${sidebarFolderMenuStyles}

            .row {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 0 5px;
                cursor: pointer;
                user-select: none;

                & .chips + .name {
                    margin-left: -2px;
                }

                &[data-merged] {
                    background-color: ${viraThemeByKeys.green['behind-fg']['small-body'].background
                        .value};
                }

                &:hover {
                    background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                        .value};
                }

                &[data-active] {
                    background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background
                        .value};
                }

                &[data-indented] {
                    padding-left: 17px;
                }

                & .actions {
                    opacity: 0.35;
                }

                &:hover .actions,
                &[data-menu-open] .actions {
                    opacity: 1;
                }
            }

            .chips {
                display: inline-flex;
                gap: 0;
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

            ${spinKeyframesCss}

            .name {
                flex-grow: 1;
                min-width: 0;
                overflow-wrap: anywhere;
                padding: 2px 0;
            }

            .name[data-pr-open] {
                text-decoration: underline;
                text-decoration-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }

            .name[data-pr-merged] {
                text-decoration: underline;
                text-decoration-color: ${viraThemeByKeys.purple.foreground.body.foreground.value};
            }

            .pr-status,
            .watch-status {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 16px;
                height: 16px;
                flex-shrink: 0;
            }

            ${hostClasses['vir-sidebar-row-mobile'].selector} {
                & .row {
                    gap: 6px;
                    min-height: 34px;
                    padding: 4px 16px;
                }

                & .row[data-indented] {
                    padding-left: 30px;
                }

                & .name {
                    padding: 4px 0;
                }

                & .chip {
                    width: 16px;
                    height: 16px;
                }
            }
        `;
    },
    render({inputs, dispatch, events}) {
        const nameWithMarkers = [
            inputs.folder.name,
            inputs.folder.git.dirty ? '*' : '',
            inputs.folder.git.notPushed ? '+' : '',
        ].join('');
        const showsLocalChanges =
            !prStatusIcons[inputs.folder.prStatus] &&
            (inputs.folder.git.dirty || inputs.folder.git.notPushed);
        const statusIcon = showsLocalChanges
            ? localChangesIcon
            : prStatusIcons[inputs.folder.prStatus];
        const statusTooltip = showsLocalChanges
            ? localChangesTooltip
            : prStatusTooltips[inputs.folder.prStatus];
        const hasPr = !!inputs.folder.prUrl;
        const isPrFinished = finishedPrStatuses.includes(inputs.folder.prStatus);

        return html`
            <div
                class="row"
                ?data-active=${inputs.isActive}
                ?data-indented=${inputs.isIndented}
                ?data-merged=${inputs.folder.prStatus === PrStatus.Merged}
                ?data-menu-open=${inputs.isMenuOpen}
                ${listen('click', () => {
                    dispatch(
                        new events.activate({
                            detail: undefined,
                        }),
                    );
                })}
            >
                <span class="chips">
                    ${renderPaneChip('AI', inputs.folder.panes.ai)}
                    ${renderPaneChip('Shell', inputs.folder.panes.shell)}
                </span>
                <span
                    class="name"
                    ?data-pr-open=${hasPr && !isPrFinished}
                    ?data-pr-merged=${hasPr && isPrFinished}
                >
                    ${nameWithMarkers}
                </span>
                ${inputs.folder.watchMode.status !== WatchModeStatus.Off ||
                inputs.folder.watchMode.message
                    ? html`
                          <span
                              class="watch-status"
                              ${tooltip(
                                  [
                                      inputs.folder.watchMode.status === WatchModeStatus.Off
                                          ? 'Watch mode stopped.'
                                          : 'Watch mode is on.',
                                      inputs.folder.watchMode.message,
                                  ]
                                      .filter(check.isTruthy)
                                      .join(' '),
                                  sidebarTooltipOptions,
                              )}
                          >
                              <${ViraIcon.assign({
                                  icon: watchModeIcons[inputs.folder.watchMode.status],
                              })}></${ViraIcon}>
                          </span>
                      `
                    : nothing}
                <span
                    class="pr-status"
                    ${statusTooltip ? tooltip(statusTooltip, sidebarTooltipOptions) : nothing}
                    ${listen('click', () => {
                        /** The row's own click listener then opens the folder on this tab. */
                        if (
                            !showsLocalChanges &&
                            inputs.folder.prStatus === PrStatus.AwaitingOtherReviews
                        ) {
                            localStorageClient.tabByFolder.writeFolder({
                                folder: inputs.folder.path,
                                value: FrontendTab.Review,
                            });
                        }
                    })}
                >
                    ${statusIcon
                        ? html`
                              <${ViraIcon.assign({
                                  icon: statusIcon,
                              })}></${ViraIcon}>
                          `
                        : nothing}
                </span>
                <span class="actions" ${listen('click', (event) => event.stopPropagation())}>
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
                            ${tooltip('Folder actions', sidebarTooltipOptions)}
                        ></${ViraButton}>
                        ${renderMenuItemEntries(
                            buildRowMenuEntries({
                                folder: inputs.folder,
                                onSelect(action) {
                                    dispatch(
                                        new events.actionSelect({
                                            detail: action,
                                        }),
                                    );
                                },
                            }),
                        )}
                    </${ViraMenuTrigger}>
                </span>
            </div>
        `;
    },
});
