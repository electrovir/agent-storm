// cspell:words unarchive unarchived unarchives unarchiving
import {type FolderInfo, WatchModeStatus} from '@agent-storm/common';
import {
    defineAppElement,
    getPrRingDisplay,
    sidebarContextMenuOffset,
    sidebarFolderMenuStyles,
    sidebarTooltipOptions,
    spinAnimationCss,
    spinKeyframesCss,
} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractEventTarget} from '@augment-vir/web';
import {classMap, css, defineElementEvent, html, listen, nothing, onDomCreated} from 'element-vir';
import {
    createColoredIcon,
    createSizedIcon,
    LucideEyeIcon,
    LucideEyeOffIcon,
    LucideGitBranchIcon,
    PopoverAnchor,
    PopoverTrigger,
    renderMenuItemEntries,
    tooltip,
    ViraIcon,
    type ViraIconSvg,
    ViraMenuTrigger,
    viraThemeByKeys,
    ViraThemeColorName,
} from 'vira';
import {type Thread, ThreadStatus} from '../../build-v2-api.js';
import {
    backgroundTaskSidebarStatusDisplay,
    questionSidebarStatusDisplay,
    sidebarStatusDisplays,
} from './thread-display.js';

const branchIcon = createColoredIcon(createSizedIcon(LucideGitBranchIcon, 12), {
    'vira-icon-stroke-color': viraThemeByKeys.grey.foreground['non-body'].foreground.value,
});

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

/** One thread in the Build V2 sidebar: its title, status, and latest activity. */
export const VirBuildV2ThreadRow = defineAppElement<{
    thread: Readonly<Thread>;
    /** The folder the thread runs in, which carries its PR status. */
    folderInfo: Readonly<FolderInfo> | undefined;
    isActive: boolean;
    /** Shows the row dimmed, with Unarchive in its menu instead of Rename and Archive. */
    isArchived: boolean;
}>()({
    tagName: 'vir-build-v2-thread-row',
    events: {
        selected: defineElementEvent<void>(),
        renamed: defineElementEvent<string>(),
        archived: defineElementEvent<void>(),
        unarchived: defineElementEvent<void>(),
    },
    state() {
        return {
            /** The title being typed while renaming. Undefined when not renaming. */
            renameText: undefined as string | undefined,
            isMenuOpen: false,
        };
    },
    styles: css`
        ${sidebarFolderMenuStyles}

        :host {
            display: block;
            min-height: 0;
        }

        /* A menu trigger is inline by default, which would shrink the row to its content. */
        ${ViraMenuTrigger} {
            display: flex;
        }

        .row {
            position: relative;
            display: flex;
            box-sizing: border-box;
            width: 100%;
            height: 28px;
            align-items: center;
            padding: 0 5px 0 17px;
            overflow: hidden;
            cursor: pointer;
            user-select: none;
            -webkit-user-select: none;
            outline: none;
            text-align: left;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:hover,
            &.menu-open {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }

            &:focus-visible {
                outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                outline-offset: -2px;
            }

            &.active {
                background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background
                    .value};
            }

            &.dim-while-running {
                opacity: 0.7;
                transition: opacity 120ms;

                &:hover,
                &:focus-within {
                    opacity: 1;
                }
            }

            &.archived {
                opacity: 0.5;

                &:hover,
                &:focus-visible {
                    opacity: 1;
                }
            }
        }

        .top {
            display: flex;
            flex-grow: 1;
            min-width: 0;
            height: 24px;
            align-items: center;
            gap: 10px;
        }

        .title {
            flex-grow: 1;
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 13px;
            font-weight: 500;
            transition: opacity 120ms;

            &.receded {
                font-weight: 400;
                opacity: 0.75;
            }
        }

        .row:hover .title.receded,
        .row:focus-visible .title.receded {
            opacity: 1;
        }

        .rename-input {
            flex-grow: 1;
            min-width: 0;
            box-sizing: border-box;
            padding: 0 4px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            border-radius: 4px;
            outline: none;
            font: inherit;
            font-size: 13px;
            font-weight: 500;
            /** The sidebar turns off text selection, which Safari also applies to typing. */
            user-select: text;
            -webkit-user-select: text;
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:focus {
                border-color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }
        }

        .trailing {
            position: relative;
            display: flex;
            flex-shrink: 0;
            min-width: 32px;
            height: 24px;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
        }

        .status {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 4px;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.has-status {
                font-weight: 500;
            }

            &.spinning ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        .folder-status,
        .watch-status {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            flex-shrink: 0;
        }

        .message-count {
            flex-shrink: 0;
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .unread-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        ${spinKeyframesCss}
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const display = inputs.thread.isAskingQuestion
            ? questionSidebarStatusDisplay
            : inputs.thread.status === ThreadStatus.Idle && inputs.thread.backgroundTaskCount
              ? backgroundTaskSidebarStatusDisplay
              : sidebarStatusDisplays[inputs.thread.status];
        const shouldRecede = display.shouldRecede && !inputs.isActive;
        const statusIcon = inputs.folderInfo?.prUrl
            ? getPrRingDisplay(inputs.folderInfo)
            : inputs.thread.worktreeBranch
              ? {
                    icon: branchIcon,
                    tooltip: inputs.thread.worktreeBranch,
                }
              : undefined;

        function select() {
            dispatch(
                new events.selected({
                    detail: undefined,
                }),
            );
        }

        function archive() {
            dispatch(
                new events.archived({
                    detail: undefined,
                }),
            );
        }

        function unarchive() {
            dispatch(
                new events.unarchived({
                    detail: undefined,
                }),
            );
        }

        function startRename() {
            if (inputs.isArchived) {
                return;
            }
            updateState({
                renameText: inputs.thread.title,
            });
        }

        function commitRename() {
            const title = state.renameText?.trim();
            updateState({
                renameText: undefined,
            });
            if (title && title !== inputs.thread.title) {
                dispatch(
                    new events.renamed({
                        detail: title,
                    }),
                );
            }
        }

        const title =
            state.renameText == undefined
                ? html`
                      <span
                          class=${classMap({
                              title: true,
                              receded: shouldRecede,
                          })}
                      >
                          ${inputs.thread.title || 'New thread'}
                      </span>
                  `
                : html`
                      <input
                          class="rename-input"
                          .value=${state.renameText}
                          aria-label="Thread title"
                          ${onDomCreated((element) => {
                              if (element instanceof HTMLInputElement) {
                                  element.focus();
                                  element.select();
                              }
                          })}
                          ${listen('input', (event) => {
                              updateState({
                                  renameText: extractEventTarget(event, HTMLInputElement).value,
                              });
                          })}
                          ${listen('keydown', (event) => {
                              event.stopPropagation();
                              if (event.key === 'Enter') {
                                  commitRename();
                              } else if (event.key === 'Escape') {
                                  updateState({
                                      renameText: undefined,
                                  });
                              }
                          })}
                          ${listen('blur', () => {
                              if (state.renameText != undefined) {
                                  commitRename();
                              }
                          })}
                          ${listen('click', (event) => {
                              event.stopPropagation();
                          })}
                          ${listen('dblclick', (event) => {
                              event.stopPropagation();
                          })}
                      />
                  `;

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
                    slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                    role="button"
                    tabindex="0"
                    aria-label=${inputs.thread.title}
                    aria-current=${inputs.isActive ? 'page' : nothing}
                    class=${classMap({
                        row: true,
                        active: inputs.isActive,
                        'menu-open': state.isMenuOpen,
                        'dim-while-running':
                            shouldRecede && inputs.thread.status === ThreadStatus.Running,
                        archived: inputs.isArchived,
                    })}
                    ${listen('click', select)}
                    ${listen('dblclick', startRename)}
                    ${listen('keydown', (event) => {
                        if (
                            event.target === event.currentTarget &&
                            [
                                'Enter',
                                ' ',
                            ].includes(event.key)
                        ) {
                            event.preventDefault();
                            select();
                        }
                    })}
                >
                    <div class="top">
                        ${title}
                        <span class="trailing">
                            <span
                                class=${classMap({
                                    status: true,
                                    'has-status': !!display.status,
                                    spinning: !!display.status?.isSpinning,
                                })}
                                ${display.status?.tooltip
                                    ? tooltip(display.status.tooltip, {
                                          delay: {
                                              milliseconds: 300,
                                          },
                                      })
                                    : nothing}
                                style=${display.status
                                    ? css`
                                          color: ${viraThemeByKeys[display.status.color].foreground
                                              .body.foreground.value};
                                      `
                                    : nothing}
                            >
                                ${display.status
                                    ? html`
                                          <${ViraIcon.assign({
                                              icon: display.status.icon,
                                          })}></${ViraIcon}>
                                          ${display.status.label || nothing}
                                      `
                                    : html`
                                          ${inputs.thread.hasUnreadReply && !inputs.isActive
                                              ? html`
                                                    <span
                                                        class="unread-dot"
                                                        role="img"
                                                        aria-label="New reply"
                                                    ></span>
                                                `
                                              : nothing}
                                      `}
                            </span>
                            ${inputs.folderInfo &&
                            (inputs.folderInfo.watchMode.status !== WatchModeStatus.Off ||
                                inputs.folderInfo.watchMode.message)
                                ? html`
                                      <span
                                          class="watch-status"
                                          ${tooltip(
                                              [
                                                  inputs.folderInfo.watchMode.status ===
                                                  WatchModeStatus.Off
                                                      ? 'Watch mode stopped.'
                                                      : 'Watch mode is on.',
                                                  inputs.folderInfo.watchMode.message,
                                              ]
                                                  .filter(check.isTruthy)
                                                  .join(' '),
                                              sidebarTooltipOptions,
                                          )}
                                      >
                                          <${ViraIcon.assign({
                                              icon: watchModeIcons[
                                                  inputs.folderInfo.watchMode.status
                                              ],
                                          })}></${ViraIcon}>
                                      </span>
                                  `
                                : nothing}
                            ${inputs.isArchived
                                ? html`
                                      <span
                                          class="message-count"
                                          ${tooltip(
                                              `${inputs.thread.userMessageCount} user ${inputs.thread.userMessageCount === 1 ? 'message' : 'messages'}`,
                                              sidebarTooltipOptions,
                                          )}
                                      >
                                          ${inputs.thread.userMessageCount > 99
                                              ? '99+'
                                              : inputs.thread.userMessageCount}
                                      </span>
                                  `
                                : statusIcon?.icon
                                  ? html`
                                        <span
                                            class="folder-status"
                                            ${statusIcon.tooltip
                                                ? tooltip(statusIcon.tooltip, sidebarTooltipOptions)
                                                : nothing}
                                        >
                                            <${ViraIcon.assign({
                                                icon: statusIcon.icon,
                                            })}></${ViraIcon}>
                                        </span>
                                    `
                                  : nothing}
                        </span>
                    </div>
                </div>
                ${renderMenuItemEntries(
                    inputs.isArchived
                        ? [
                              {
                                  content: 'Unarchive',
                                  onClick: unarchive,
                              },
                          ]
                        : [
                              {
                                  content: 'Rename',
                                  onClick: startRename,
                              },
                              {
                                  content: 'Archive',
                                  onClick: archive,
                              },
                          ],
                )}
            </${ViraMenuTrigger}>
        `;
    },
});
