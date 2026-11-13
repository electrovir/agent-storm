// cspell:words haspopup
import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideCheckIcon,
    LucideChevronDownIcon,
    LucideSearchIcon,
    ViraIcon,
    viraShadows,
    viraThemeByKeys,
} from 'vira';
import {type AiProvider, type ProviderModel, type ReasoningEffort} from '../../build-v2-api.js';
import {readEffectiveEffort, reasoningEffortLabels} from '../../util/reasoning-effort.js';
import {providerLabels} from './thread-display.js';
import {providerIcons, railProviderIcons} from './vir-ai-chat-model-picker-icons.js';

/** A provider's models, or why they couldn't be read. Undefined while they load. */
export type ProviderModelList =
    | Readonly<{
          models: ReadonlyArray<Readonly<ProviderModel>>;
      }>
    | Readonly<{
          errorMessage: string;
      }>;

type PickerRow = Readonly<{
    key: string;
    provider: AiProvider;
    model: Readonly<ProviderModel>;
}>;

const chevronIcon = createSizedIcon(LucideChevronDownIcon, 14);
const searchIcon = createSizedIcon(LucideSearchIcon, 16);
const checkIcon = createSizedIcon(LucideCheckIcon, 14);

/**
 * Picks the model and reasoning effort a thread uses, from a searchable list with a provider rail.
 * Picking another provider's model also picks that provider. The right-hand column lists the
 * highlighted model's efforts, when it has any. Arrow Up and Down move through the models, Arrow
 * Right moves into the efforts, Arrow Left moves back, and Enter picks.
 */
export const VirAiChatModelPicker = defineAppElement<{
    providerModels: Readonly<Partial<Record<AiProvider, ProviderModelList>>>;
    /** The providers whose models are offered, in order. */
    providers: ReadonlyArray<AiProvider>;
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
    isDisabled: boolean;
}>()({
    tagName: 'vir-ai-chat-model-picker',
    events: {
        /** `model` is empty when the picked model is the provider's default. */
        modelChange: defineElementEvent<
            Readonly<{
                provider: AiProvider;
                model: string;
                /** Unset when the model has no effort setting or the default effort was kept. */
                effort: ReasoningEffort | undefined;
            }>
        >(),
    },
    state() {
        return {
            isOpen: false,
            query: '',
            railProvider: undefined as AiProvider | undefined,
            highlightedIndex: 0,
            /** The effort row the keyboard is on. Undefined while it is on the model rows. */
            effortIndex: undefined as number | undefined,
            removeOutsidePointerListener: undefined as (() => void) | undefined,
        };
    },
    init({host, updateState}) {
        function closeOnOutsidePointer(event: PointerEvent) {
            if (host.instanceState.isOpen && !event.composedPath().includes(host)) {
                updateState({
                    isOpen: false,
                });
            }
        }
        globalThis.document.addEventListener('pointerdown', closeOnOutsidePointer, true);
        updateState({
            removeOutsidePointerListener() {
                globalThis.document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
            },
        });
    },
    cleanup({state}) {
        state.removeOutsidePointerListener?.();
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
                position: relative;
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
                &[aria-expanded='true'] {
                    background-color: ${hoverBackground};
                    color: ${textColor};
                }

                &:focus-visible {
                    outline: 2px solid ${viraThemeByKeys.blue.foreground.body.foreground.value};
                    outline-offset: -2px;
                }

                &:disabled {
                    cursor: default;
                    opacity: 0.6;
                    pointer-events: none;
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

            .popover {
                position: absolute;
                bottom: 100%;
                left: 0;
                z-index: 130;
                margin-bottom: 4px;
                display: flex;
                max-width: calc(100vw - 32px);
                max-height: 346px;
                overflow: hidden;
                border-radius: 8px;
                border: 1px solid ${borderColor};
                background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
                ${viraShadows.menuShadow}
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

            .option {
                display: flex;
                align-items: center;
                gap: 8px;
                min-height: 28px;
                padding: 4px 8px;
                box-sizing: border-box;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;

                &:hover,
                &.highlighted {
                    background-color: ${selectedBackground};
                }

                & .option-name {
                    min-width: 0;
                    flex-grow: 1;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                }

                & ${ViraIcon} {
                    flex-shrink: 0;
                }

                & .check {
                    color: ${mutedColor};
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
        const rows = query
            ? inputs.providers.flatMap(rowsFor).filter((row) => {
                  return [
                      row.model.name,
                      row.model.id,
                      row.model.description,
                  ].some((text) => text.toLowerCase().includes(query));
              })
            : rowsFor(activeRailProvider);
        const selectedRow = inputs.providers.flatMap(rowsFor).find((row) => {
            return (
                row.provider === inputs.provider &&
                (inputs.model ? row.model.id === inputs.model : row.model.isDefault)
            );
        });
        const highlightedRow = rows[state.highlightedIndex];
        /**
         * The efforts column follows the highlighted model, or the selected one before any row
         * exists.
         */
        const effortRow = highlightedRow || selectedRow;
        const efforts = effortRow?.model.supportedEfforts ?? [];
        const selectedEffort = readEffectiveEffort({
            model: selectedRow?.model,
            effort: inputs.effort,
        });
        const effortColumnSelected = readEffectiveEffort({
            model: effortRow?.model,
            effort: effortRow === selectedRow ? inputs.effort : undefined,
        });
        const activeList = inputs.providerModels[activeRailProvider];
        const emptyLabel = query
            ? 'No models found'
            : activeList
              ? 'errorMessage' in activeList
                  ? activeList.errorMessage
                  : 'No models found'
              : 'Loading…';
        const modelName = selectedRow?.model.name || inputs.model || 'Default model';

        function close() {
            updateState({
                isOpen: false,
                query: '',
                effortIndex: undefined,
            });
        }

        function pick({
            row,
            effort,
        }: Readonly<{row: PickerRow; effort: ReasoningEffort | undefined}>) {
            close();
            dispatch(
                new events.modelChange({
                    detail: {
                        provider: row.provider,
                        model: row.model.isDefault ? '' : row.model.id,
                        effort:
                            effort && row.model.supportedEfforts.includes(effort)
                                ? effort
                                : undefined,
                    },
                }),
            );
        }

        function focusSearch() {
            requestAnimationFrame(() => {
                host.shadowRoot.querySelector('input')?.focus();
            });
        }

        function scrollHighlightedIntoView() {
            requestAnimationFrame(() => {
                host.shadowRoot.querySelector('.highlighted')?.scrollIntoView({
                    block: 'nearest',
                });
            });
        }

        function handleKeydown(event: KeyboardEvent) {
            if (event.isComposing) {
                return;
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
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
                    if (effortRow && effort) {
                        event.preventDefault();
                        event.stopPropagation();
                        pick({
                            row: effortRow,
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
                        Math.min(rows.length - 1, state.highlightedIndex + direction),
                    ),
                });
                scrollHighlightedIntoView();
            } else if (event.key === 'ArrowRight' && efforts.length) {
                event.preventDefault();
                updateState({
                    effortIndex: Math.max(
                        0,
                        efforts.findIndex((effort) => effort === effortColumnSelected),
                    ),
                });
            } else if (event.key === 'Enter' && highlightedRow) {
                event.preventDefault();
                event.stopPropagation();
                pick({
                    row: highlightedRow,
                    effort: inputs.effort,
                });
            }
        }

        return html`
            <button
                type="button"
                class="model-button"
                aria-label=${[
                    modelName,
                    selectedEffort && reasoningEffortLabels[selectedEffort],
                ]
                    .filter(check.isTruthy)
                    .join(' ')}
                aria-haspopup="dialog"
                aria-expanded=${state.isOpen}
                ?disabled=${inputs.isDisabled}
                ${listen('click', () => {
                    if (inputs.isDisabled) {
                        return;
                    }
                    updateState({
                        isOpen: !state.isOpen,
                        query: '',
                        railProvider: inputs.provider,
                        highlightedIndex: 0,
                        effortIndex: undefined,
                    });
                    focusSearch();
                })}
            >
                <${ViraIcon.assign({
                    icon: providerIcons[inputs.provider],
                })}></${ViraIcon}>
                <span class="model-label">
                    ${modelName}${selectedEffort ? ` ${reasoningEffortLabels[selectedEffort]}` : ''}
                </span>
                <${ViraIcon.assign({
                    icon: chevronIcon,
                })}
                    class="chevron"
                ></${ViraIcon}>
            </button>
            ${state.isOpen
                ? html`
                      <div class="popover" role="dialog" ${listen('keydown', handleKeydown)}>
                          <div class="rail" aria-label="Providers">
                              ${inputs.providers.map((provider) => {
                                  return html`
                                      <button
                                          type="button"
                                          class=${provider === activeRailProvider && !query
                                              ? 'rail-button active'
                                              : 'rail-button'}
                                          title=${providerLabels[provider]}
                                          aria-label=${providerLabels[provider]}
                                          aria-pressed=${provider === activeRailProvider}
                                          ${listen('click', () => {
                                              updateState({
                                                  railProvider: provider,
                                                  highlightedIndex: 0,
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
                                              query: extractEventTarget(event, HTMLInputElement)
                                                  .value,
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
                                                    <div
                                                        role="option"
                                                        class=${index === state.highlightedIndex &&
                                                        !check.isNumber(state.effortIndex)
                                                            ? 'option highlighted'
                                                            : 'option'}
                                                        aria-selected=${row.key ===
                                                        selectedRow?.key}
                                                        ${listen('click', () => {
                                                            pick({
                                                                row,
                                                                effort: inputs.effort,
                                                            });
                                                        })}
                                                        ${listen('mousemove', () => {
                                                            if (index !== state.highlightedIndex) {
                                                                updateState({
                                                                    highlightedIndex: index,
                                                                    effortIndex: undefined,
                                                                });
                                                            }
                                                        })}
                                                    >
                                                        <${ViraIcon.assign({
                                                            icon: providerIcons[row.provider],
                                                        })}></${ViraIcon}>
                                                        <span
                                                            class="option-name"
                                                            title=${row.model.description}
                                                        >
                                                            ${row.model.name}
                                                        </span>
                                                        ${row.key === selectedRow?.key
                                                            ? html`
                                                                  <${ViraIcon.assign({
                                                                      icon: checkIcon,
                                                                  })}
                                                                      class="check"
                                                                  ></${ViraIcon}>
                                                              `
                                                            : nothing}
                                                    </div>
                                                `;
                                            })}
                                        </div>
                                    `
                                  : html`
                                        <div class="empty">${emptyLabel}</div>
                                    `}
                          </div>
                          ${efforts.length && effortRow
                              ? html`
                                    <div class="column efforts-column" aria-label="Reasoning">
                                        <div class="column-header">
                                            <span>Reasoning</span>
                                            <span>${effortRow.model.name}</span>
                                        </div>
                                        <div class="list" role="listbox">
                                            ${efforts.map((effort, index) => {
                                                return html`
                                                    <div
                                                        role="option"
                                                        class=${index === state.effortIndex
                                                            ? 'option highlighted'
                                                            : 'option'}
                                                        aria-selected=${effort ===
                                                        effortColumnSelected}
                                                        ${listen('click', () => {
                                                            pick({
                                                                row: effortRow,
                                                                effort,
                                                            });
                                                        })}
                                                    >
                                                        <span class="option-name">
                                                            ${reasoningEffortLabels[effort]}
                                                        </span>
                                                        ${effort === effortColumnSelected
                                                            ? html`
                                                                  <${ViraIcon.assign({
                                                                      icon: checkIcon,
                                                                  })}
                                                                      class="check"
                                                                  ></${ViraIcon}>
                                                              `
                                                            : nothing}
                                                    </div>
                                                `;
                                            })}
                                        </div>
                                    </div>
                                `
                              : nothing}
                      </div>
                  `
                : nothing}
        `;
    },
});
