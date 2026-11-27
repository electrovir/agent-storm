import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideChevronDownIcon,
    LucideSearchIcon,
    LucideZapIcon,
    PopoverAnchor,
    PopoverTrigger,
    tooltip,
    ViraIcon,
    ViraMenuItem,
    ViraPopoverTrigger,
    viraShadows,
    viraThemeByKeys,
    type PopoverManager,
} from 'vira';
import {
    AiProvider,
    providerLabels,
    type ProviderModel,
    type ReasoningEffort,
} from '../../build-api.js';
import {readEffectiveEffort, reasoningEffortLabels} from '../../util/reasoning-effort.js';
import {providerIcons, railProviderIcons} from './vir-ai-chat-model-picker-icons.js';

/** A provider's models, or why they couldn't be read. Undefined while they load. */
export type ProviderModelList =
    | Readonly<{
          models: ReadonlyArray<Readonly<ProviderModel>>;
      }>
    | Readonly<{
          errorMessage: string;
      }>;

/** A thread's model choice, as the picker reports it. */
export type ModelSelection = Readonly<{
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset when the model has no effort setting or the default effort was kept. */
    effort: ReasoningEffort | undefined;
    /** Unset for standard speed, or when the model has no faster tier. */
    speedTier: string | undefined;
}>;

type PickerRow = Readonly<{
    key: string;
    provider: AiProvider;
    model: Readonly<ProviderModel>;
}>;

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 14);
const searchIcon = createSizedIcon(LucideSearchIcon, 16);
const zapIcon = createSizedIcon(LucideZapIcon, 14);
const providers = getEnumValues(AiProvider);

/**
 * Picks the model and reasoning effort a thread uses, from a searchable list with a provider rail.
 * Picking another provider's model also picks that provider. The right-hand column lists the
 * selected model's efforts, when it has any. A Speed row under them sets that model's service tier
 * when it offers a faster one. Arrow Up and Down move through the models, Arrow Right moves into
 * the efforts, Arrow Left moves back, and Enter picks.
 */
export const VirAiChatModelPicker = defineAppElement<{
    providerModels: Readonly<Partial<Record<AiProvider, ProviderModelList>>>;
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
    /** Unset for standard speed. */
    speedTier: string | undefined;
    isDisabled: boolean;
}>()({
    tagName: 'vir-ai-chat-model-picker',
    events: {
        modelChange: defineElementEvent<ModelSelection>(),
    },
    state() {
        return {
            isOpen: false,
            query: '',
            railProvider: undefined as AiProvider | undefined,
            highlightedIndex: 0,
            showsOlderModels: false,
            /** The effort row the keyboard is on. Undefined while it is on the model rows. */
            effortIndex: undefined as number | undefined,
            popoverManager: undefined as PopoverManager | undefined,
        };
    },
    styles() {
        const textColor = viraThemeByKeys.grey.foreground.body.foreground.value;
        const mutedColor = viraThemeByKeys.grey.foreground['non-body'].foreground.value;
        const faintColor = viraThemeByKeys.grey.foreground.placeholder.foreground.value;
        const borderColor = viraThemeByKeys.grey.foreground.decoration.foreground.value;
        const selectedBackground = viraThemeByKeys.grey['behind-fg']['small-body'].background.value;
        const hoverBackground = selectedBackground;

        return css`
            :host {
                display: flex;
                min-width: 0;
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
                text-align: left;
            }

            .model-button {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 28px;
                padding: 0 8px;
                min-width: 0;
                border-radius: 8px;
                font-weight: 500;
                white-space: nowrap;
                color: ${mutedColor};

                &:hover,
                &.open {
                    background-color: ${hoverBackground};
                    color: ${textColor};
                }

                & .model-label {
                    min-width: 0;
                    max-width: 224px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }

                & ${ViraIcon} {
                    flex-shrink: 0;
                }

                & .chevron {
                    opacity: 0.6;
                }
            }

            .zap {
                color: ${viraThemeByKeys.yellow.foreground.body.foreground.value};
            }

            .popover {
                display: flex;
                flex-direction: column;
                max-width: calc(100vw - 32px);
                max-height: 346px;
                overflow: hidden;
                border-radius: 8px;
                border: 1px solid ${borderColor};
                background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
                ${viraShadows.menuShadow}
            }

            .columns {
                display: flex;
                min-height: 0;
            }

            .rail {
                display: flex;
                flex-direction: column;
                flex-shrink: 0;
                gap: 4px;
                width: 44px;
                padding: 4px;
                box-sizing: border-box;
                overflow-y: auto;

                & .rail-button {
                    position: relative;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    aspect-ratio: 1;
                    border-radius: 6px;

                    &:hover,
                    &:focus-visible {
                        background-color: ${hoverBackground};
                        outline: none;
                    }

                    &.active::after {
                        content: '';
                        position: absolute;
                        right: -1px;
                        top: 10px;
                        bottom: 10px;
                        width: 3px;
                        border-radius: 2px;
                        background-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
                    }
                }
            }

            .column {
                display: flex;
                flex-direction: column;
                min-height: 0;
                min-width: 0;
                border-left: 1px solid ${borderColor};
            }

            .models-column {
                width: 280px;
            }

            .efforts-column {
                width: 192px;
                flex-shrink: 0;
            }

            .column-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin: 10px 12px 0;
                padding-bottom: 6px;
                border-bottom: 1px solid ${borderColor};
                font-size: 13px;
                color: ${mutedColor};
                position: relative;

                & span {
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;

                    &:first-child {
                        flex-shrink: 0;
                    }
                }

                &.search {
                    &:focus-within {
                        border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground
                            .value};
                    }

                    & ${ViraIcon} {
                        flex-shrink: 0;
                        color: ${faintColor};
                    }
                }

                & input {
                    flex-grow: 1;
                    min-width: 0;
                    font: inherit;
                    font-size: 14px;
                    color: ${textColor};
                    background: none;
                    border: none;
                    outline: none;
                    padding: 0;

                    &::placeholder {
                        color: ${faintColor};
                    }
                }
            }

            .list {
                display: flex;
                flex-direction: column;
                gap: 2px;
                padding: 8px 4px;
                overflow-y: auto;
                overscroll-behavior: contain;
                min-height: 0;
            }

            ${ViraMenuItem} {
                min-height: 28px;
                border-radius: 4px;
                font-size: 14px;

                &:hover,
                &[data-highlighted] {
                    background-color: ${selectedBackground};
                }

                & .option-provider {
                    margin-left: 6px;
                    color: ${faintColor};
                }

                &.older-toggle {
                    font-size: 12px;
                    color: ${faintColor};
                }
            }

            .speed {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 6px 12px;
                border-top: 1px solid ${borderColor};
                font-size: 13px;
                color: ${mutedColor};

                & .segments {
                    display: inline-flex;
                    gap: 2px;
                    padding: 2px;
                    border-radius: 6px;
                    background-color: ${selectedBackground};
                }

                & .segment {
                    display: inline-flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 8px;
                    border-radius: 4px;

                    &[aria-checked='true'] {
                        background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground
                            .value};
                        color: ${textColor};
                    }

                    &:focus-visible {
                        outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                        outline-offset: -2px;
                    }
                }
            }

            .empty {
                padding: 12px;
                text-align: center;
                color: ${mutedColor};
                font-size: 14px;
            }
        `;
    },
    render({inputs, state, updateState, dispatch, events, host}) {
        function rowsFor(provider: AiProvider) {
            const list = inputs.providerModels[provider];
            return list && 'models' in list
                ? list.models.map((model): PickerRow => {
                      return {
                          key: `${provider}/${model.id}`,
                          provider,
                          model,
                      };
                  })
                : [];
        }
        const activeRailProvider = state.railProvider || inputs.provider;
        const query = state.query.trim().toLowerCase();
        const providerRows = rowsFor(activeRailProvider);
        const currentRowCount = providerRows.filter((row) => !row.model.isLegacy).length;
        /** Search always includes older models, so the toggle only shows while browsing. */
        const hasOlderToggle = !query && currentRowCount < providerRows.length;
        const rows = query
            ? providers.flatMap(rowsFor).filter((row) => {
                  return [
                      row.model.name,
                      row.model.id,
                      row.model.description,
                  ].some((text) => text.toLowerCase().includes(query));
              })
            : providerRows.filter((row) => state.showsOlderModels || !row.model.isLegacy);
        /** The older-models toggle trails the rows, so it takes the index after the last row. */
        const highlightCount = rows.length + (hasOlderToggle ? 1 : 0);
        const selectedRow = providers.flatMap(rowsFor).find((row) => {
            return (
                row.provider === inputs.provider &&
                (inputs.model ? row.model.id === inputs.model : row.model.isDefault)
            );
        });
        const highlightedRow = rows[state.highlightedIndex];
        const efforts = selectedRow?.model.supportedEfforts ?? [];
        const selectedEffort = readEffectiveEffort({
            model: selectedRow?.model,
            effort: inputs.effort,
        });
        const speedTiers = selectedRow?.model.speedTiers ?? [];
        const selectedSpeedTier = speedTiers.find((tier) => tier.id === inputs.speedTier);
        const activeList = inputs.providerModels[activeRailProvider];
        const emptyLabel = query
            ? 'No models found'
            : activeList
              ? 'errorMessage' in activeList
                  ? activeList.errorMessage
                  : 'No models found'
              : 'Loading…';
        const modelName = selectedRow?.model.name || inputs.model || 'Default model';

        function highlightRow(index: number) {
            if (index !== state.highlightedIndex) {
                updateState({
                    highlightedIndex: index,
                    effortIndex: undefined,
                });
            }
        }

        /** Keeps the highlight in place: on the first older model when shown, else on the toggle. */
        function toggleOlderModels() {
            updateState({
                showsOlderModels: !state.showsOlderModels,
                highlightedIndex: currentRowCount,
                effortIndex: undefined,
            });
            focusSearch();
        }

        function emitModelChange({
            row,
            effort,
            speedTier,
        }: Readonly<{
            row: PickerRow;
            effort: ReasoningEffort | undefined;
            speedTier: string | undefined;
        }>) {
            dispatch(
                new events.modelChange({
                    detail: {
                        provider: row.provider,
                        model: row.model.isDefault ? '' : row.model.id,
                        effort:
                            effort && row.model.supportedEfforts.includes(effort)
                                ? effort
                                : undefined,
                        speedTier: row.model.speedTiers.some((tier) => tier.id === speedTier)
                            ? speedTier
                            : undefined,
                    },
                }),
            );
        }

        function pick({
            row,
            effort,
        }: Readonly<{row: PickerRow; effort: ReasoningEffort | undefined}>) {
            state.popoverManager?.hide();
            emitModelChange({
                row,
                effort,
                speedTier: inputs.speedTier,
            });
        }

        /**
         * Stays open on a model with reasoning efforts, with the efforts column focused, so the
         * effort can be picked next.
         */
        function selectModel(row: PickerRow) {
            if (!row.model.supportedEfforts.length) {
                pick({
                    row,
                    effort: selectedEffort,
                });
                return;
            }
            const effort = readEffectiveEffort({
                model: row.model,
                effort: selectedEffort,
            });
            updateState({
                effortIndex: Math.max(
                    0,
                    row.model.supportedEfforts.findIndex((supported) => supported === effort),
                ),
            });
            emitModelChange({
                row,
                /** Keeps the effort the previous model ran at, when the new one supports it. */
                effort: selectedEffort,
                speedTier: inputs.speedTier,
            });
            focusSearch();
        }

        function focusSearch() {
            requestAnimationFrame(() => {
                host.shadowRoot.querySelector('input')?.focus();
            });
        }

        function scrollHighlightedIntoView() {
            requestAnimationFrame(() => {
                host.shadowRoot.querySelector('[data-highlighted]')?.scrollIntoView({
                    block: 'nearest',
                });
            });
        }

        function handleKeydown(event: KeyboardEvent) {
            /** A focused button handles its own Enter, which must not also pick a model. */
            if (event.isComposing || event.composedPath()[0] instanceof HTMLButtonElement) {
                return;
            }
            const direction =
                event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : undefined;

            if (check.isNumber(state.effortIndex)) {
                if (direction) {
                    event.preventDefault();
                    updateState({
                        effortIndex: Math.max(
                            0,
                            Math.min(efforts.length - 1, state.effortIndex + direction),
                        ),
                    });
                } else if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    updateState({
                        effortIndex: undefined,
                    });
                } else if (event.key === 'Enter') {
                    const effort = efforts[state.effortIndex];
                    if (selectedRow && effort) {
                        event.preventDefault();
                        event.stopPropagation();
                        pick({
                            row: selectedRow,
                            effort,
                        });
                    }
                }
                return;
            }

            if (direction) {
                event.preventDefault();
                updateState({
                    highlightedIndex: Math.max(
                        0,
                        Math.min(highlightCount - 1, state.highlightedIndex + direction),
                    ),
                });
                scrollHighlightedIntoView();
            } else if (event.key === 'ArrowRight' && efforts.length) {
                event.preventDefault();
                updateState({
                    effortIndex: Math.max(
                        0,
                        efforts.findIndex((effort) => effort === selectedEffort),
                    ),
                });
            } else if (
                event.key === 'Enter' &&
                hasOlderToggle &&
                state.highlightedIndex === rows.length
            ) {
                event.preventDefault();
                event.stopPropagation();
                toggleOlderModels();
            } else if (event.key === 'Enter' && highlightedRow) {
                event.preventDefault();
                event.stopPropagation();
                selectModel(highlightedRow);
            }
        }

        return html`
            <${ViraPopoverTrigger.assign({
                trigger: PopoverTrigger.Click,
                popoverAnchor: PopoverAnchor.Left,
                keepOpenAfterInteraction: true,
                useInsideFocus: true,
                isDisabled: inputs.isDisabled,
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
                        query: '',
                        railProvider: inputs.provider,
                        highlightedIndex: 0,
                        showsOlderModels: !!selectedRow?.model.isLegacy,
                        effortIndex: undefined,
                    });
                    if (event.detail) {
                        focusSearch();
                    }
                })}
            >
                <span
                    class="model-button ${state.isOpen ? 'open' : ''}"
                    slot=${ViraPopoverTrigger.slotNames['vira-popover-trigger-trigger']}
                    aria-label=${[
                        modelName,
                        selectedEffort && reasoningEffortLabels[selectedEffort],
                        selectedSpeedTier?.name,
                    ]
                        .filter(check.isTruthy)
                        .join(' ')}
                >
                    <${ViraIcon.assign({
                        icon: providerIcons[inputs.provider],
                    })}></${ViraIcon}>
                    <span class="model-label" part="label">
                        ${modelName}${selectedEffort
                            ? ` ${reasoningEffortLabels[selectedEffort]}`
                            : ''}
                    </span>
                    ${selectedSpeedTier
                        ? html`
                              <${ViraIcon.assign({
                                  icon: zapIcon,
                              })}
                                  class="zap"
                              ></${ViraIcon}>
                          `
                        : nothing}
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
                              role="dialog"
                              ${listen('keydown', handleKeydown)}
                          >
                              <div class="columns">
                                  <div class="rail" aria-label="Providers">
                                      ${providers.map((provider) => {
                                          return html`
                                              <button
                                                  type="button"
                                                  class=${provider === activeRailProvider && !query
                                                      ? 'rail-button active'
                                                      : 'rail-button'}
                                                  ${tooltip(providerLabels[provider])}
                                                  aria-label=${providerLabels[provider]}
                                                  aria-pressed=${provider === activeRailProvider}
                                                  ${listen('click', () => {
                                                      updateState({
                                                          railProvider: provider,
                                                          highlightedIndex: 0,
                                                          showsOlderModels:
                                                              selectedRow?.provider === provider &&
                                                              selectedRow.model.isLegacy,
                                                          effortIndex: undefined,
                                                      });
                                                      focusSearch();
                                                  })}
                                              >
                                                  <${ViraIcon.assign({
                                                      icon: railProviderIcons[provider],
                                                  })}></${ViraIcon}>
                                              </button>
                                          `;
                                      })}
                                  </div>
                                  <div class="column models-column">
                                      <div class="column-header search">
                                          <${ViraIcon.assign({
                                              icon: searchIcon,
                                          })}></${ViraIcon}>
                                          <input
                                              type="text"
                                              placeholder="Search models..."
                                              autocomplete="off"
                                              spellcheck="false"
                                              .value=${state.query}
                                              ${listen('input', (event) => {
                                                  updateState({
                                                      query: extractEventTarget(
                                                          event,
                                                          HTMLInputElement,
                                                      ).value,
                                                      highlightedIndex: 0,
                                                      effortIndex: undefined,
                                                  });
                                              })}
                                          />
                                      </div>
                                      ${rows.length
                                          ? html`
                                                <div class="list" role="listbox">
                                                    ${rows.map((row, index) => {
                                                        return html`
                                                            <${ViraMenuItem.assign({
                                                                selected:
                                                                    row.key === selectedRow?.key,
                                                                keepOpenAfterInteraction: true,
                                                            })}
                                                                ?data-highlighted=${index ===
                                                                    state.highlightedIndex &&
                                                                !check.isNumber(state.effortIndex)}
                                                                ${row.model.description
                                                                    ? tooltip(row.model.description)
                                                                    : nothing}
                                                                ${listen('click', () => {
                                                                    selectModel(row);
                                                                })}
                                                                ${listen('mousemove', () => {
                                                                    highlightRow(index);
                                                                })}
                                                            >
                                                                ${row.model.name}${query
                                                                    ? html`
                                                                          <span
                                                                              class="option-provider"
                                                                          >
                                                                              ${providerLabels[
                                                                                  row.provider
                                                                              ]}
                                                                          </span>
                                                                      `
                                                                    : nothing}
                                                            </${ViraMenuItem}>
                                                        `;
                                                    })}
                                                    ${hasOlderToggle
                                                        ? html`
                                                              <${ViraMenuItem.assign({
                                                                  selected: false,
                                                                  keepOpenAfterInteraction: true,
                                                              })}
                                                                  class="older-toggle"
                                                                  aria-expanded=${state.showsOlderModels}
                                                                  ?data-highlighted=${state.highlightedIndex ===
                                                                      rows.length &&
                                                                  !check.isNumber(
                                                                      state.effortIndex,
                                                                  )}
                                                                  ${listen(
                                                                      'click',
                                                                      toggleOlderModels,
                                                                  )}
                                                                  ${listen('mousemove', () => {
                                                                      highlightRow(rows.length);
                                                                  })}
                                                              >
                                                                  ${state.showsOlderModels
                                                                      ? 'Hide older models'
                                                                      : 'Show older models'}
                                                              </${ViraMenuItem}>
                                                          `
                                                        : nothing}
                                                </div>
                                            `
                                          : html`
                                                <div class="empty">${emptyLabel}</div>
                                            `}
                                  </div>
                                  ${efforts.length && selectedRow
                                      ? html`
                                            <div
                                                class="column efforts-column"
                                                aria-label="Reasoning"
                                            >
                                                <div class="column-header">
                                                    <span>Reasoning</span>
                                                    <span>${selectedRow.model.name}</span>
                                                </div>
                                                <div class="list" role="listbox">
                                                    ${efforts.map((effort, index) => {
                                                        return html`
                                                            <${ViraMenuItem.assign({
                                                                selected: effort === selectedEffort,
                                                                keepOpenAfterInteraction: true,
                                                            })}
                                                                ?data-highlighted=${index ===
                                                                state.effortIndex}
                                                                ${listen('click', () => {
                                                                    pick({
                                                                        row: selectedRow,
                                                                        effort,
                                                                    });
                                                                })}
                                                            >
                                                                ${reasoningEffortLabels[effort]}
                                                            </${ViraMenuItem}>
                                                        `;
                                                    })}
                                                </div>
                                            </div>
                                        `
                                      : nothing}
                              </div>
                              ${selectedRow && speedTiers.length
                                  ? html`
                                        <div class="speed">
                                            <span>Speed</span>
                                            <div
                                                class="segments"
                                                role="radiogroup"
                                                aria-label="Speed"
                                            >
                                                ${[
                                                    {
                                                        id: undefined,
                                                        name: 'Standard',
                                                    },
                                                    ...speedTiers,
                                                ].map((tier) => {
                                                    return html`
                                                        <button
                                                            type="button"
                                                            class="segment"
                                                            role="radio"
                                                            aria-checked=${tier.id ===
                                                            selectedSpeedTier?.id}
                                                            ${listen('click', () => {
                                                                emitModelChange({
                                                                    row: selectedRow,
                                                                    effort: inputs.effort,
                                                                    speedTier: tier.id,
                                                                });
                                                            })}
                                                        >
                                                            ${tier.id
                                                                ? html`
                                                                      <${ViraIcon.assign({
                                                                          icon: zapIcon,
                                                                      })}
                                                                          class="zap"
                                                                      ></${ViraIcon}>
                                                                  `
                                                                : nothing}
                                                            ${tier.name}
                                                        </button>
                                                    `;
                                                })}
                                            </div>
                                        </div>
                                    `
                                  : nothing}
                          </div>
                      `
                    : nothing}
            </${ViraPopoverTrigger}>
        `;
    },
});
