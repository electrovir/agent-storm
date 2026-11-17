import {defineAppElement} from '@agent-storm/core/frontend';
import {extractEventTarget} from '@augment-vir/web';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {
    createSizedIcon,
    LucideArchiveIcon,
    LucideArrowUpIcon,
    LucideSquareIcon,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    viraThemeByKeys,
} from 'vira';
import {type AiProvider, type ReasoningEffort, type RuntimeMode} from '../../build-v2-api.js';
import {
    VirAiChatModelPicker,
    type ModelSelection,
    type ProviderModelList,
} from './vir-ai-chat-model-picker.element.js';
import {VirAiChatPermissions} from './vir-ai-chat-permissions.element.js';

const sendIcon = createSizedIcon(LucideArrowUpIcon, 16);
const stopIcon = createSizedIcon(LucideSquareIcon, 12);
const archiveIcon = createSizedIcon(LucideArchiveIcon, 16);

/**
 * The message box under a chat. Enter sends and Shift+Enter starts a new line. While the thread
 * runs and the box is empty, Stop takes the send button's place. With a `questionAction`, the box
 * holds a custom answer and the send button moves through the questions instead.
 */
export const VirAiChatComposer = defineAppElement<{
    text: string;
    placeholder: string;
    isRunning: boolean;
    /** While a send or stop is in flight. */
    isBusy: boolean;
    /** Shows the archive button beside send. */
    canArchive: boolean;
    providerModels: Readonly<Partial<Record<AiProvider, ProviderModelList>>>;
    provider: AiProvider;
    /** Empty for the provider's default model. */
    model: string;
    /** Unset for the model's default effort. */
    effort: ReasoningEffort | undefined;
    /** Unset for standard speed. */
    speedTier: string | undefined;
    runtimeMode: RuntimeMode;
    /** Focuses the message box each time this turns on. */
    isShown: boolean;
    /** Set while a question waits, to label the send button and submit even with an empty box. */
    questionAction:
        | Readonly<{
              label: string;
              isEnabled: boolean;
          }>
        | undefined;
}>()({
    tagName: 'vir-ai-chat-composer',
    events: {
        textChange: defineElementEvent<string>(),
        submitted: defineElementEvent<string>(),
        stopRequested: defineElementEvent<void>(),
        archiveRequested: defineElementEvent<void>(),
        modelChange: defineElementEvent<ModelSelection>(),
        runtimeModeChange: defineElementEvent<RuntimeMode>(),
    },
    state() {
        return {
            wasShown: false,
        };
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
        }

        .controls {
            display: flex;
            align-items: center;
            gap: 2px;
            min-width: 0;

            & ${VirAiChatModelPicker} {
                flex-shrink: 1;
            }
        }

        .actions {
            display: flex;
            flex-shrink: 0;
            align-items: center;
            gap: 12px;
        }

        .action {
            flex-shrink: 0;
            width: 32px;
            height: 32px;
            ${ViraButton.cssVars['vira-button-border-radius'].name}: 50%;

            &.labeled {
                width: auto;
                ${ViraButton.cssVars['vira-button-border-radius'].name}: 16px;
            }

            &.stop {
                ${ViraButton.cssVars['vira-button-border-width'].name}: 0;
                ${ViraButton.cssVars['vira-button-disabled-text-color'].name}: ${viraThemeByKeys
                    .grey.foreground.placeholder.foreground.value};
                ${ViraButton.cssVars['vira-button-disabled-background-color']
                    .name}: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
                ${ViraButton.cssVars['vira-button-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-background-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.background.value};
                ${ViraButton.cssVars['vira-button-hover-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-hover-background-color'].name}: ${viraThemeByKeys
                    .red['on-self'].body.background.value};
                ${ViraButton.cssVars['vira-button-active-text-color'].name}: ${viraThemeByKeys.red[
                    'on-self'
                ].body.foreground.value};
                ${ViraButton.cssVars['vira-button-active-background-color'].name}: ${viraThemeByKeys
                    .red['on-self'].body.background.value};
            }
        }
    `,
    render({inputs, state, updateState, dispatch, events, host}) {
        if (inputs.isShown !== state.wasShown) {
            updateState({
                wasShown: inputs.isShown,
            });
            if (inputs.isShown) {
                requestAnimationFrame(() => {
                    host.shadowRoot.querySelector('textarea')?.focus();
                });
            }
        }
        const hasText = !!inputs.text.trim();
        const canSend = (inputs.questionAction?.isEnabled ?? hasText) && !inputs.isBusy;
        const showsStop = !inputs.questionAction && inputs.isRunning && !hasText;

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
                    aria-label=${inputs.questionAction ? 'Your own answer' : 'Message'}
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
                    <div class="controls">
                        <${VirAiChatPermissions.assign({
                            runtimeMode: inputs.runtimeMode,
                        })}
                            ${listen(VirAiChatPermissions.events.runtimeModeChange, (event) => {
                                dispatch(
                                    new events.runtimeModeChange({
                                        detail: event.detail,
                                    }),
                                );
                            })}
                        ></${VirAiChatPermissions}>
                        <${VirAiChatModelPicker.assign({
                            providerModels: inputs.providerModels,
                            provider: inputs.provider,
                            model: inputs.model,
                            effort: inputs.effort,
                            speedTier: inputs.speedTier,
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
                    </div>
                    <div class="actions">
                        ${inputs.canArchive
                            ? html`
                                  <${ViraButton.assign({
                                      icon: archiveIcon,
                                      color: ViraColorVariant.Neutral,
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      isDisabled: inputs.isBusy,
                                  })}
                                      class="action"
                                      title="Archive thread"
                                      aria-label="Archive thread"
                                      ${listen('click', () => {
                                          if (inputs.isBusy) {
                                              return;
                                          }
                                          dispatch(
                                              new events.archiveRequested({
                                                  detail: undefined,
                                              }),
                                          );
                                      })}
                                  ></${ViraButton}>
                              `
                            : nothing}
                        ${showsStop
                            ? html`
                                  <${ViraButton.assign({
                                      icon: stopIcon,
                                      color: ViraColorVariant.Custom,
                                      isDisabled: inputs.isBusy,
                                  })}
                                      class="action stop"
                                      title="Interrupt"
                                      aria-label="Stop generation"
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
                                  ></${ViraButton}>
                              `
                            : inputs.questionAction
                              ? html`
                                    <${ViraButton.assign({
                                        text: inputs.questionAction.label,
                                        color: ViraColorVariant.Brand,
                                        isDisabled: !canSend,
                                    })}
                                        class="action labeled"
                                        ${listen('click', submit)}
                                    ></${ViraButton}>
                                `
                              : html`
                                    <${ViraButton.assign({
                                        icon: sendIcon,
                                        color: ViraColorVariant.Brand,
                                        isDisabled: !canSend,
                                    })}
                                        class="action"
                                        title="Submit message"
                                        aria-label="Submit message"
                                        ${listen('click', submit)}
                                    ></${ViraButton}>
                                `}
                    </div>
                </div>
            </div>
        `;
    },
});
