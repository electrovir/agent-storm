import {PaneKind, PaneStatus, type AiDefinition, type SessionMeta} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideHourglassIcon,
    LucideLoaderIcon,
    LucideSquareTerminalIcon,
    noUserSelect,
    PopoverTrigger,
    renderMenuItemEntries,
    ViraIcon,
    ViraMenuTrigger,
    viraThemeByKeys,
    type ViraIconSvg,
    type ViraMenuItemEntry,
} from 'vira';
import {defineAppElement} from '../define-app-element.js';
import {spinAnimationCss, spinKeyframesCss} from './spin-styles.js';
import {VirAiAvatar} from './vir-ai-avatar.element.js';

/** An AI tab shows its AI's avatar instead. */
const sessionKindIcons: Record<PaneKind, ViraIconSvg | undefined> = {
    [PaneKind.Ai]: undefined,
    [PaneKind.Shell]: createSizedIcon(LucideSquareTerminalIcon, 12),
};
const sessionActivityIndicators: Record<
    PaneStatus,
    | {
          icon: ViraIconSvg;
          title: string;
      }
    | undefined
> = {
    [PaneStatus.None]: undefined,
    [PaneStatus.Busy]: {
        icon: createSizedIcon(LucideLoaderIcon, 12),
        title: 'Working',
    },
    [PaneStatus.Stalled]: {
        icon: createSizedIcon(LucideHourglassIcon, 12),
        title: 'Unfinished work, but no sign of activity for a while. It may be stuck.',
    },
    [PaneStatus.Idle]: undefined,
    [PaneStatus.Exited]: undefined,
};

/**
 * One session's tab in a pane's tab strip, with its activity, its AI's avatar, and its menu.
 * Restart lives in this menu rather than on the folder's sidebar row because with several sessions
 * per pane, "restart the AI" is only meaningful against a specific one.
 */
export const VirSessionTab = defineAppElement<{
    session: Readonly<SessionMeta>;
    kind: PaneKind;
    /** 0-based. Labels a tab whose session has no name. */
    index: number;
    isSelected: boolean;
    status: PaneStatus;
    /** The AI the tab runs. Undefined shows no avatar. */
    ai: Readonly<AiDefinition> | undefined;
    canChangeAi: boolean;
    /** The last remaining tab can't be closed: a pane with no tabs has nothing to show. */
    canClose: boolean;
}>()({
    tagName: 'vir-session-tab',
    events: {
        selected: defineElementEvent<void>(),
        /** Carries the new name, empty to go back to the tab's number. */
        renamed: defineElementEvent<string>(),
        restartRequested: defineElementEvent<void>(),
        changeAiRequested: defineElementEvent<void>(),
        closeRequested: defineElementEvent<void>(),
    },
    styles: css`
        :host {
            display: contents;
        }

        .session-tab {
            ${noUserSelect};
            display: inline-flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
            min-height: 20px;
            padding: 1px 2px;
            border: 1px solid transparent;
            border-radius: 4px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            background: transparent;
            font: inherit;
            max-width: 160px;
        }

        .session-tab:hover {
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .session-tab[data-selected] {
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            border-color: ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
        }

        .session-tab-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            padding: 0 2px;
        }

        /*
         * Sized whether or not it holds an icon so a tab keeps its width when activity starts and
         * stops — the strip wraps, so a tab that grew mid-run could reflow the whole row.
         */
        .session-activity {
            flex-grow: 0;
            flex-shrink: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 12px;
            height: 12px;
            color: ${viraThemeByKeys.pink.foreground.header.foreground.value};
        }

        .session-activity[data-busy] ${ViraIcon} {
            ${spinAnimationCss}
        }

        ${spinKeyframesCss}

        .session-activity[data-stalled] {
            color: ${viraThemeByKeys.yellow.foreground.header.foreground.value};
        }

        .session-activity[data-idle] {
            visibility: hidden;
        }
    `,
    render({inputs, dispatch, events}) {
        const label = inputs.session.name || String(inputs.index + 1);
        const indicator = sessionActivityIndicators[inputs.status];
        /**
         * Annotated so each literal widens to `ViraMenuItemEntry` (whose `content` is an
         * `HtmlInterpolation`, not a `string`) before the conditional entries are filtered out.
         */
        const menuEntries: ReadonlyArray<ViraMenuItemEntry | undefined> = [
            {
                content: 'Rename',
                onClick() {
                    /**
                     * A native prompt rather than a modal: it's the smallest thing that does the
                     * job, and `vir-terminal` already uses `window.prompt` for its paste fallback.
                     * Worth upgrading to an inline input if renaming turns out to be frequent.
                     */
                    const nextName = window.prompt(
                        'Session name (empty to use its number):',
                        label,
                    );
                    if (nextName != undefined) {
                        dispatch(
                            new events.renamed({
                                detail: nextName,
                            }),
                        );
                    }
                },
            },
            {
                content: 'Restart',
                onClick() {
                    dispatch(
                        new events.restartRequested({
                            detail: undefined,
                        }),
                    );
                },
            },
            inputs.canChangeAi
                ? {
                      content: 'Change AI',
                      onClick() {
                          dispatch(
                              new events.changeAiRequested({
                                  detail: undefined,
                              }),
                          );
                      },
                  }
                : undefined,
            inputs.canClose
                ? {
                      content: 'Close',
                      onClick() {
                          dispatch(
                              new events.closeRequested({
                                  detail: undefined,
                              }),
                          );
                      },
                  }
                : undefined,
        ];

        return html`
            <${ViraMenuTrigger.assign({
                trigger: PopoverTrigger.ContextMenu,
            })}>
                <div
                    class="session-tab"
                    slot=${ViraMenuTrigger.slotNames['vira-menu-trigger-trigger']}
                    role="tab"
                    ?data-selected=${inputs.isSelected}
                    aria-selected=${inputs.isSelected}
                    title=${inputs.session.name || `Session ${inputs.index + 1}`}
                    ${listen('click', () => {
                        dispatch(
                            new events.selected({
                                detail: undefined,
                            }),
                        );
                    })}
                >
                    ${inputs.ai
                        ? html`
                              <${VirAiAvatar.assign({
                                  name: inputs.ai.name,
                                  avatarFile: inputs.ai.avatarFile || '',
                                  sizePx: 12,
                              })}
                                  title=${inputs.ai.name}
                              ></${VirAiAvatar}>
                          `
                        : sessionKindIcons[inputs.kind]
                          ? html`
                                <${ViraIcon.assign({
                                    icon: sessionKindIcons[inputs.kind],
                                })}></${ViraIcon}>
                            `
                          : nothing}
                    <span class="session-tab-label">${label}</span>
                    <span
                        class="session-activity"
                        ?data-idle=${!indicator}
                        ?data-busy=${inputs.status === PaneStatus.Busy}
                        ?data-stalled=${inputs.status === PaneStatus.Stalled}
                        title=${indicator?.title || ''}
                    >
                        <${ViraIcon.assign({
                            icon: indicator?.icon,
                        })}></${ViraIcon}>
                    </span>
                </div>
                ${renderMenuItemEntries(menuEntries.filter(check.isTruthy))}
            </${ViraMenuTrigger}>
        `;
    },
});
