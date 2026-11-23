// cspell:words menuitemradio
import {defineAppElement} from '@agent-storm/core/frontend';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideChevronDownIcon,
    LucideLockIcon,
    LucidePenLineIcon,
    LucideShieldCheckIcon,
    LucideShieldOffIcon,
    PopoverAnchor,
    PopoverTrigger,
    ViraIcon,
    ViraPopoverTrigger,
    viraShadows,
    viraThemeByKeys,
    type PopoverManager,
    type ViraIconSvg,
} from 'vira';
import {RuntimeMode} from '../../build-v2-api.js';

const runtimeModeDisplays: Readonly<
    Record<
        RuntimeMode,
        Readonly<{
            label: string;
            description: string;
            icon: ViraIconSvg;
        }>
    >
> = {
    [RuntimeMode.Supervised]: {
        label: 'Supervised',
        description: 'Ask before commands and file changes.',
        icon: createSizedIcon(LucideLockIcon, 14),
    },
    [RuntimeMode.AutoAcceptEdits]: {
        label: 'Auto-accept edits',
        description: 'Auto-approve edits, ask before other actions.',
        icon: createSizedIcon(LucidePenLineIcon, 14),
    },
    [RuntimeMode.Auto]: {
        label: 'Auto',
        description: 'The provider approves routine actions and asks about the rest.',
        icon: createSizedIcon(LucideShieldCheckIcon, 14),
    },
    [RuntimeMode.FullAccess]: {
        label: 'Full access',
        description: 'Allow commands and edits without prompts.',
        /** An open lock reads like a closed one at this size. A crossed-out shield doesn't. */
        icon: createSizedIcon(LucideShieldOffIcon, 14),
    },
};

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 14);

/**
 * The composer chip that shows and picks a thread's runtime mode. Its menu is one row of mode
 * buttons, with the hovered or focused mode's name and description below. Arrow Left and Right move
 * along the row.
 */
export const VirAiChatPermissions = defineAppElement<{
    runtimeMode: RuntimeMode;
}>()({
    tagName: 'vir-ai-chat-permissions',
    events: {
        runtimeModeChange: defineElementEvent<RuntimeMode>(),
    },
    state() {
        return {
            isOpen: false,
            /** The mode the menu describes while it is hovered or focused, before a pick. */
            previewMode: undefined as RuntimeMode | undefined,
            popoverManager: undefined as PopoverManager | undefined,
        };
    },
    styles() {
        const textColor = viraThemeByKeys.grey.foreground.body.foreground.value;
        const mutedColor = viraThemeByKeys.grey.foreground['non-body'].foreground.value;
        const selectedBackground = viraThemeByKeys.grey['behind-fg']['small-body'].background.value;
        const focusColor = viraThemeByKeys.blue.foreground.body.foreground.value;

        return css`
            :host {
                display: flex;
                flex-shrink: 0;
                font-size: 14px;
                color: ${textColor};
            }

            button {
                font: inherit;
                color: inherit;
                background: none;
                border: none;
                padding: 0;
                cursor: pointer;
            }

            .chip {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 28px;
                padding: 0 8px 0 6px;
                border-radius: 8px;
                font-weight: 500;
                white-space: nowrap;
                color: ${mutedColor};

                &:hover,
                &.open {
                    background-color: ${selectedBackground};
                    color: ${textColor};
                }

                & ${ViraIcon} {
                    flex-shrink: 0;
                }

                & .chevron {
                    opacity: 0.6;
                }
            }

            .popover {
                display: flex;
                flex-direction: column;
                gap: 6px;
                width: 288px;
                max-width: calc(100vw - 32px);
                box-sizing: border-box;
                padding: 6px 8px 8px;
                border-radius: 8px;
                border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
                background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
                ${viraShadows.menuShadow}
            }

            .heading {
                font-size: 12px;
                font-weight: 500;
                color: ${mutedColor};
            }

            .modes {
                display: flex;
                padding: 2px;
                border-radius: 8px;
                background-color: ${viraThemeByKeys.grey['behind-fg']['highest-contrast'].background
                    .value};

                & button {
                    display: flex;
                    flex-grow: 1;
                    align-items: center;
                    justify-content: center;
                    height: 28px;
                    border-radius: 6px;
                    color: ${mutedColor};

                    &:hover {
                        color: ${textColor};
                    }

                    &:focus-visible {
                        outline: 2px solid ${focusColor};
                        outline-offset: -2px;
                    }

                    &[aria-checked='true'] {
                        color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
                        background-color: ${focusColor};
                    }
                }
            }

            /**
             * Every mode's description is stacked in one cell so the popover is always as tall as
             * the longest one and doesn't resize while moving along the row.
             */
            .descriptions {
                display: grid;
            }

            .description {
                grid-area: 1 / 1;
                display: flex;
                flex-direction: column;
                gap: 2px;
                font-size: 13px;

                &.inactive {
                    visibility: hidden;
                }

                & span:first-child {
                    font-weight: 500;
                }

                & span:last-child {
                    color: ${mutedColor};
                }
            }
        `;
    },
    render({inputs, state, updateState, dispatch, events, host}) {
        const shown = runtimeModeDisplays[inputs.runtimeMode];
        const describedMode = state.previewMode || inputs.runtimeMode;
        const modes = Object.values(RuntimeMode);

        function pick(runtimeMode: RuntimeMode) {
            state.popoverManager?.hide();
            if (runtimeMode !== inputs.runtimeMode) {
                dispatch(
                    new events.runtimeModeChange({
                        detail: runtimeMode,
                    }),
                );
            }
        }

        function focusMode(runtimeMode: RuntimeMode) {
            requestAnimationFrame(() => {
                host.shadowRoot
                    .querySelector<HTMLButtonElement>(`[data-mode="${runtimeMode}"]`)
                    ?.focus();
            });
        }

        return html`
            <${ViraPopoverTrigger.assign({
                trigger: PopoverTrigger.Click,
                popoverAnchor: PopoverAnchor.Left,
                keepOpenAfterInteraction: true,
                useInsideFocus: true,
                popoverOffset: {
                    vertical: 4,
                },
            })}
                ${listen(ViraPopoverTrigger.events.init, (event) => {
                    updateState({
                        popoverManager: event.detail.popoverManager,
                    });
                })}
                ${listen(ViraPopoverTrigger.events.openChange, (event) => {
                    updateState({
                        isOpen: event.detail,
                        previewMode: undefined,
                    });
                    if (event.detail) {
                        focusMode(inputs.runtimeMode);
                    }
                })}
            >
                <span
                    class="chip ${state.isOpen ? 'open' : ''}"
                    slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-trigger']}
                    aria-label=${`Permissions: ${shown.label}`}
                >
                    <${ViraIcon.assign({
                        icon: shown.icon,
                    })}></${ViraIcon}>
                    <span part="label">${shown.label}</span>
                    <${ViraIcon.assign({
                        icon: chevronIcon,
                    })}
                        class="chevron"
                    ></${ViraIcon}>
                </span>
                ${state.isOpen
                    ? html`
                          <div
                              class="popover"
                              slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-popover']}
                              role="menu"
                              aria-label="Permissions"
                              ${listen('keydown', (event) => {
                                  const direction =
                                      event.key === 'ArrowRight'
                                          ? 1
                                          : event.key === 'ArrowLeft'
                                            ? -1
                                            : undefined;
                                  const focused = modes.indexOf(
                                      state.previewMode || inputs.runtimeMode,
                                  );
                                  const next = direction ? modes[focused + direction] : undefined;
                                  if (next) {
                                      event.preventDefault();
                                      focusMode(next);
                                  }
                              })}
                          >
                              <div class="heading">Permissions</div>
                              <div class="modes" role="group">
                                  ${modes.map((runtimeMode) => {
                                      const display = runtimeModeDisplays[runtimeMode];
                                      return html`
                                          <button
                                              type="button"
                                              role="menuitemradio"
                                              data-mode=${runtimeMode}
                                              aria-label=${display.label}
                                              aria-checked=${runtimeMode === inputs.runtimeMode}
                                              ${listen('click', () => {
                                                  pick(runtimeMode);
                                              })}
                                              ${listen('mouseenter', () => {
                                                  updateState({
                                                      previewMode: runtimeMode,
                                                  });
                                              })}
                                              ${listen('focus', () => {
                                                  updateState({
                                                      previewMode: runtimeMode,
                                                  });
                                              })}
                                          >
                                              <${ViraIcon.assign({
                                                  icon: display.icon,
                                              })}></${ViraIcon}>
                                          </button>
                                      `;
                                  })}
                              </div>
                              <div class="descriptions">
                                  ${modes.map((runtimeMode) => {
                                      const display = runtimeModeDisplays[runtimeMode];
                                      return html`
                                          <div
                                              class="description ${runtimeMode === describedMode
                                                  ? ''
                                                  : 'inactive'}"
                                          >
                                              <span>${display.label}</span>
                                              <span>${display.description}</span>
                                          </div>
                                      `;
                                  })}
                              </div>
                          </div>
                      `
                    : nothing}
            </${ViraPopoverTrigger}>
        `;
    },
});
