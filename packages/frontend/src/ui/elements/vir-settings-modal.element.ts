import {configJsonSchema, defaultConfig, type Config} from '@agent-storm/common';
import {css, defineElement, defineElementEvent, html, listen, onDomCreated} from 'element-vir';
import {type JsonValue} from 'type-fest';
import {
    ViraButton,
    ViraColorVariant,
    ViraJsonForm,
    ViraModal,
    viraThemeByKeys,
    type ViraJsonSchema,
    type ViraJsonSchemaObject,
} from 'vira';
import {getConfig, putConfig, restartDaemon} from '../../util/api-client.js';

/**
 * Config properties that round-trip through `/config` (so the backend can persist them across
 * restarts) but are entirely backend-managed — the user has no business editing them in the
 * settings UI. Stripped from both the schema we hand to `ViraJsonForm` and from the form's
 * input/output so changes to user-editable fields don't blow away the runtime state.
 */
const backendManagedKeys = ['githubPollingAutoDisable'] as const satisfies ReadonlyArray<
    keyof Config
>;

const formJsonSchema: ViraJsonSchemaObject = (() => {
    const properties: Record<string, ViraJsonSchema> = {
        ...(configJsonSchema.properties as Record<string, ViraJsonSchema>),
    };
    backendManagedKeys.forEach((key) => {
        delete properties[key];
    });
    return {
        ...configJsonSchema,
        properties,
        required: configJsonSchema.required.filter(
            (key) => !(backendManagedKeys as ReadonlyArray<string>).includes(key),
        ),
    };
})();

function toJsonValue(config: Readonly<Config>): JsonValue {
    const visible = {
        ...config,
    } as Record<string, unknown>;
    backendManagedKeys.forEach((key) => {
        delete visible[key];
    });
    return JSON.parse(JSON.stringify(visible)) as JsonValue;
}

function fromJsonValue(value: JsonValue, current: Readonly<Config>): Config {
    /**
     * Preserve the current backend-managed fields when merging the user-edited form back into a
     * full Config. Without this, the form's output (which only knows about user-editable fields)
     * would lack those keys and they'd revert to defaults on save.
     */
    const merged: Config = {
        ...defaultConfig,
        ...(value as Partial<Config>),
    };
    backendManagedKeys.forEach((key) => {
        merged[key] = current[key];
    });
    return merged;
}

export const VirSettingsModal = defineElement<{
    open: boolean;
}>()({
    tagName: 'vir-settings-modal',
    events: {
        /**
         * Emitted when the user dismisses the modal (clicks the underlying scrim, hits Cancel /
         * Save, etc.). The parent owns the `open` input and is responsible for flipping it false.
         */
        closeRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            pending: undefined as JsonValue | undefined,
            /**
             * Snapshot of the Config we loaded from the backend. Needed at save() time so we can
             * preserve the backend-managed fields (stripped from the user-facing form) when merging
             * the form's output back into a full Config.
             */
            loaded: undefined as Config | undefined,
            /**
             * The useWebgl value at load time, captured so save() can detect a flip and trigger a
             * page reload — existing terminals only read the config at construction.
             */
            useWebgl: undefined as boolean | undefined,
            loadError: undefined as string | undefined,
            saveError: undefined as string | undefined,
            saving: false,
            restartingDaemon: false,
            daemonRestartError: undefined as string | undefined,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 16px;
            min-width: 540px;
            max-width: 720px;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }

        .error {
            padding: 8px 12px;
            border-radius: 6px;
            border: 1px solid currentColor;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
            white-space: pre-wrap;
        }

        .loading {
            padding: 24px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const reset = () => {
            updateState({
                pending: undefined,
                loaded: undefined,
                useWebgl: undefined,
                loadError: undefined,
                saveError: undefined,
                saving: false,
                restartingDaemon: false,
                daemonRestartError: undefined,
            });
        };

        const restartDaemonAction = async () => {
            if (
                !window.confirm(
                    'Restart the PTY daemon? All running terminal sessions will be killed.',
                )
            ) {
                return;
            }
            updateState({
                restartingDaemon: true,
                daemonRestartError: undefined,
            });
            try {
                await restartDaemon();
                updateState({
                    restartingDaemon: false,
                });
            } catch (error: unknown) {
                updateState({
                    restartingDaemon: false,
                    daemonRestartError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const load = async () => {
            try {
                const config = await getConfig();
                updateState({
                    pending: toJsonValue(config),
                    loaded: config,
                    // optionalShape default is true; coerce undefined → true for comparison.
                    useWebgl: config.useWebgl,
                    loadError: undefined,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const save = async () => {
            if (!state.pending || state.saving) {
                return;
            }
            updateState({
                saving: true,
                saveError: undefined,
            });
            try {
                const next = fromJsonValue(state.pending, state.loaded ?? defaultConfig);
                await putConfig(next);
                const nextUseWebgl = next.useWebgl;
                const webglChanged =
                    state.useWebgl !== undefined && state.useWebgl !== nextUseWebgl;
                reset();
                dispatch(new events.closeRequested());
                if (webglChanged) {
                    // Existing terminals only read useWebgl at construction; reload so the
                    // new renderer choice applies everywhere.
                    window.location.reload();
                }
            } catch (error: unknown) {
                updateState({
                    saving: false,
                    saveError: error instanceof Error ? error.message : String(error),
                });
            }
        };

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Settings',
            })}
                ${listen(ViraModal.events.modalClose, () => {
                    reset();
                    dispatch(new events.closeRequested());
                })}
            >
                ${inputs.open
                    ? html`
                          <div
                              class="body"
                              ${onDomCreated(() => {
                                  if (!state.pending && !state.loadError) {
                                      void load();
                                  }
                              })}
                          >
                              ${state.loadError
                                  ? html`
                                        <div class="error">${state.loadError}</div>
                                    `
                                  : ''}
                              ${state.saveError
                                  ? html`
                                        <div class="error">${state.saveError}</div>
                                    `
                                  : ''}
                              ${state.daemonRestartError
                                  ? html`
                                        <div class="error">${state.daemonRestartError}</div>
                                    `
                                  : ''}
                              ${state.pending
                                  ? html`
                                        <${ViraJsonForm.assign({
                                            value: state.pending,
                                            schema: formJsonSchema,
                                            isDisabled: state.saving,
                                        })}
                                            ${listen(ViraJsonForm.events.valueChange, (event) => {
                                                updateState({
                                                    pending: event.detail,
                                                });
                                            })}
                                        ></${ViraJsonForm}>
                                    `
                                  : state.loadError
                                    ? ''
                                    : html`
                                          <div class="loading">Loading config...</div>
                                      `}
                              <div class="footer">
                                  <${ViraButton.assign({
                                      text: state.restartingDaemon
                                          ? 'Restarting daemon...'
                                          : 'Restart PTY daemon',
                                      color: ViraColorVariant.Danger,
                                      isDisabled: state.restartingDaemon || state.saving,
                                  })}
                                      ${listen('click', () => void restartDaemonAction())}
                                  ></${ViraButton}>
                                  <span style="flex-grow: 1;"></span>
                                  <${ViraButton.assign({
                                      text: 'Cancel',
                                      color: ViraColorVariant.Neutral,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', () => {
                                          reset();
                                          dispatch(new events.closeRequested());
                                      })}
                                  ></${ViraButton}>
                                  <${ViraButton.assign({
                                      text: state.saving ? 'Saving...' : 'Save',
                                      color: ViraColorVariant.Brand,
                                      isDisabled: state.saving || !state.pending,
                                  })}
                                      ${listen('click', () => void save())}
                                  ></${ViraButton}>
                              </div>
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
