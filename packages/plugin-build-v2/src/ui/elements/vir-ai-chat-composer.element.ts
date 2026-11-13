import {defineAppElement} from '@agent-storm/core/frontend';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {
    createSizedIcon,
    LucideArrowUpIcon,
    LucideSquareIcon,
    ViraIcon,
    viraThemeByKeys,
} from 'vira';
import {type AiProvider, type ReasoningEffort} from '../../build-v2-api.js';
import {VirAiChatModelPicker, type ProviderModelList} from './vir-ai-chat-model-picker.element.js';

const sendIcon = createSizedIcon(LucideArrowUpIcon, 16);
const stopIcon = createSizedIcon(LucideSquareIcon, 12);

/**
 * The message box under a chat. Enter sends and Shift+Enter starts a new line. While the thread
 * runs and the box is empty, Stop takes the send button's place.
 */
export const VirAiChatComposer = defineAppElement<{
    text: string;
    placeholder: string;
    isRunning: boolean;
    /** While a send or stop is in flight. */
    isBusy: boolean;
    providerModels: Readonly<Partial<Record<AiProvider, ProviderModelList>>>;
    /** The providers the model picker offers models from. */
    providers: ReadonlyArray<AiProvider>;
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
}>()({
    tagName: 'vir-ai-chat-composer',
    events: {
        textChange: defineElementEvent<string>(),
        submitted: defineElementEvent<string>(),
        stopRequested: defineElementEvent<void>(),
        modelChange: defineElementEvent<
            Readonly<{
                provider: AiProvider;
                model: string;
                /** Unset for the model's default effort. */
                effort: ReasoningEffort | undefined;
            }>
        >(),
    },
    styles: css`
        :host {
            display: block;
            position: relative;
            z-index: 30;
        }

        .composer {
            display: flex;
            flex-direction: column;
            width: 100%;
            box-sizing: border-box;
            border-radius: 16px;
            border: 1px solid ${viraThemeByKeys.grey.foreground.decoration.foreground.value};
            background-color: ${viraThemeByKeys.grey['behind-bg'].body.foreground.value};
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};

            &:focus-within {
                border-color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            }
        }

        textarea {
            field-sizing: content;
            box-sizing: border-box;
            width: 100%;
            min-height: 3.5em;
            max-height: 208px;
            padding: 14px 16px 8px;
            font: inherit;
            font-size: 14px;
            color: inherit;
            background: none;
            border: none;
            outline: none;
            resize: none;
            overflow-y: auto;

            &::placeholder {
                color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            }
        }

        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            padding: 0 8px 8px;

            & ${VirAiChatModelPicker} {
                flex-shrink: 1;
            }
        }

        .action {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            padding: 0;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            transition: background-color 150ms;

            &.send {
                color: ${viraThemeByKeys.blue['on-self'].body.foreground.value};
                background-color: ${viraThemeByKeys.blue['on-self'].body.background.value};

                &:hover:not(:disabled) {
                    background-color: ${viraThemeByKeys.blue.foreground['highest-contrast']
                        .foreground.value};
                }
            }

            &.stop {
                color: ${viraThemeByKeys.red['on-self'].body.foreground.value};
                background-color: ${viraThemeByKeys.red['on-self'].body.background.value};
            }

            &:disabled {
                cursor: default;
                color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }
        }
    `,
    render({inputs, dispatch, events}) {
        const hasText = !!inputs.text.trim();
        const canSend = hasText && !inputs.isBusy;
        const showsStop = inputs.isRunning && !hasText;

        function submit() {
            if (!canSend) {
                return;
            }
            dispatch(
                new events.submitted({
                    detail: inputs.text.trim(),
                }),
            );
        }

        return html`
            <div class="composer">
                <textarea
                    rows="2"
                    data-testid="composer-editor"
                    aria-label="Message"
                    placeholder=${inputs.placeholder}
                    .value=${inputs.text}
                    ${listen('input', (event) => {
                        dispatch(
                            new events.textChange({
                                detail: extractEventTarget(event, HTMLTextAreaElement).value,
                            }),
                        );
                    })}
                    ${listen('keydown', (event) => {
                        if (
                            event.key === 'Enter' &&
                            !event.shiftKey &&
                            !event.altKey &&
                            !event.isComposing
                        ) {
                            event.preventDefault();
                            submit();
                        }
                    })}
                ></textarea>
                <div class="footer">
                    <${VirAiChatModelPicker.assign({
                        providerModels: inputs.providerModels,
                        providers: inputs.providers,
                        provider: inputs.provider,
                        model: inputs.model,
                        effort: inputs.effort,
                        isDisabled: inputs.isRunning || inputs.isBusy,
                    })}
                        ${listen(VirAiChatModelPicker.events.modelChange, (event) => {
                            dispatch(
                                new events.modelChange({
                                    detail: event.detail,
                                }),
                            );
                        })}
                    ></${VirAiChatModelPicker}>
                    ${showsStop
                        ? html`
                              <button
                                  type="button"
                                  class="action stop"
                                  title="Interrupt"
                                  aria-label="Stop generation"
                                  ?disabled=${inputs.isBusy}
                                  ${listen('click', () => {
                                      if (inputs.isBusy) {
                                          return;
                                      }
                                      dispatch(
                                          new events.stopRequested({
                                              detail: undefined,
                                          }),
                                      );
                                  })}
                              >
                                  <${ViraIcon.assign({
                                      icon: stopIcon,
                                  })}></${ViraIcon}>
                              </button>
                          `
                        : html`
                              <button
                                  type="submit"
                                  class="action send"
                                  title="Submit message"
                                  aria-label="Submit message"
                                  ?disabled=${!canSend}
                                  ${listen('click', submit)}
                              >
                                  <${ViraIcon.assign({
                                      icon: sendIcon,
                                  })}></${ViraIcon}>
                              </button>
                          `}
                </div>
            </div>
        `;
    },
});
