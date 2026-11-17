import {
    defineAppElement,
    sidebarContextMenuOffset,
    sidebarFolderMenuStyles,
    spinAnimationCss,
    spinKeyframesCss,
} from '@agent-storm/core/frontend';
import {extractEventTarget} from '@augment-vir/web';
import {classMap, css, defineElementEvent, html, listen, nothing, onDomCreated} from 'element-vir';
import {
    createSizedIcon,
    LucideFolderGit2Icon,
    PopoverAnchor,
    PopoverTrigger,
    renderMenuItemEntries,
    tooltip,
    ViraIcon,
    ViraMenuTrigger,
    viraThemeByKeys,
} from 'vira';
import {ThreadStatus, type Thread} from '../../build-v2-api.js';
import {sidebarStatusDisplays} from './thread-display.js';

const branchIcon = createSizedIcon(LucideFolderGit2Icon, 14);

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

function compactTimeLabel(timestamp: number) {
    const elapsed = Date.now() - timestamp;
    return elapsed < minuteMs
        ? 'now'
        : elapsed < hourMs
          ? `${Math.floor(elapsed / minuteMs)}m`
          : elapsed < dayMs
            ? `${Math.floor(elapsed / hourMs)}h`
            : `${Math.floor(elapsed / dayMs)}d`;
}

/** One thread in the Build V2 sidebar: its title, status, and latest activity. */
export const VirBuildV2ThreadRow = defineAppElement<{
    thread: Readonly<Thread>;
    isActive: boolean;
}>()({
    tagName: 'vir-build-v2-thread-row',
    events: {
        selected: defineElementEvent<void>(),
        renamed: defineElementEvent<string>(),
        archived: defineElementEvent<void>(),
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

            &.multiline {
                height: auto;
                flex-direction: column;
                align-items: stretch;
                justify-content: center;
                padding-top: 3px;
                padding-bottom: 3px;
            }

            &.dim-while-running {
                opacity: 0.7;
                transition: opacity 120ms;

                &:hover,
                &:focus-within {
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
            font-size: 14px;
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
            font-size: 14px;
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
        }

        .status {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 4px;
            font-size: 12px;
            font-variant-numeric: tabular-nums;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            &.has-status {
                font-weight: 500;
            }

            &.spinning ${ViraIcon} {
                ${spinAnimationCss}
            }
        }

        .unread-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        ${spinKeyframesCss}

        .branch {
            display: flex;
            min-width: 0;
            align-items: center;
            gap: 6px;
            margin-top: 2px;
            font-size: 12px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};

            & .branch-name {
                min-width: 0;
                overflow: hidden;
                white-space: nowrap;
                text-overflow: ellipsis;
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const display = sidebarStatusDisplays[inputs.thread.status];
        const shouldRecede = display.shouldRecede && !inputs.isActive;
        const isMultiline = !!inputs.thread.worktreeBranch;

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

        function startRename() {
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
                        multiline: isMultiline,
                        'menu-open': state.isMenuOpen,
                        'dim-while-running':
                            shouldRecede && inputs.thread.status === ThreadStatus.Running,
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
                                          ${compactTimeLabel(inputs.thread.updatedAt)}
                                      `}
                            </span>
                        </span>
                    </div>
                    ${isMultiline
                        ? html`
                              <div class="branch">
                                  <${ViraIcon.assign({
                                      icon: branchIcon,
                                  })}></${ViraIcon}>
                                  <span class="branch-name">${inputs.thread.worktreeBranch}</span>
                              </div>
                          `
                        : nothing}
                </div>
                ${renderMenuItemEntries([
                    {
                        content: 'Rename',
                        onClick: startRename,
                    },
                    {
                        content: 'Archive',
                        onClick: archive,
                    },
                ])}
            </${ViraMenuTrigger}>
        `;
    },
});
