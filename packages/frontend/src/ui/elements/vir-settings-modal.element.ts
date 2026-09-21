import {configJsonSchema, defaultConfig, type Config} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    getObjectTypedKeys,
    omitObjectKeys,
    pickObjectKeys,
    type JsonValue,
} from '@augment-vir/common';
import {css, defineElement, defineElementEvent, html, listen, onDomCreated} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraForm,
    ViraFormFieldType,
    ViraJsonForm,
    ViraModal,
    ViraSelect,
    viraThemeByKeys,
    type ViraJsonSchema,
    type ViraJsonSchemaObject,
    type ViraSelectOption,
} from 'vira';
import {checkPath, getConfig, putConfig, restartDaemon} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {localStorageClient, scrollbackLimit} from '../../util/local-storage-client.js';

/**
 * Config properties that round-trip through `/config` (so the backend can persist them across
 * restarts) but are hidden from the settings form. Reasons vary: `githubPollingAutoDisable` is
 * entirely backend-managed (the user has no business editing it here), while `repos` and
 * `folderAiIds` are per-folder data managed through the sidebar rather than this JSON form (and too
 * large / noisy to belong here). `aiDefinitions` has its own modal, `defaultAiId` is rendered as
 * the AI picker below, and `tlsCertPath` gets its own input so a path that doesn't exist can report
 * an error directly beneath it — the JSON form has no per-property error slot. Stripped from both
 * the schema we hand to `ViraJsonForm` and from the form's input/output, then preserved on save so
 * hiding them never blows away their runtime state.
 */
const hiddenConfigKeys = [
    'githubPollingAutoDisable',
    'repos',
    'aiDefinitions',
    'defaultAiId',
    'folderAiIds',
    'tlsCertPath',
] as const satisfies ReadonlyArray<keyof Config>;

const formJsonSchema: ViraJsonSchemaObject = (() => {
    const properties: Record<string, ViraJsonSchema> = {
        ...(configJsonSchema.properties as Record<string, ViraJsonSchema>),
    };
    hiddenConfigKeys.forEach((key) => {
        delete properties[key];
    });
    return {
        ...configJsonSchema,
        properties,
        /**
         * `toJsonValue` already keeps unsupported keys out of the form's value, so the form should
         * never meet one. This is the backstop: `configJsonSchema` has to keep
         * `additionalProperties: false` for `mapSchemaToShape`, and inheriting that here would lock
         * the user out of every setting over a single stray key.
         */
        additionalProperties: true,
        required: configJsonSchema.required.filter(
            (key) => !(hiddenConfigKeys as ReadonlyArray<string>).includes(key),
        ),
    };
})();

/** Exactly the keys the form renders: every schema property that isn't hidden. */
const formConfigKeys = getObjectTypedKeys(formJsonSchema.properties || {});

/**
 * The AI choices for the default picker. An empty leading option covers a config with no AI defined
 * yet, which is also the state a brand-new install starts in if the seeded definition was deleted.
 */
function aiOptions(config: Readonly<Config> | undefined): ViraSelectOption[] {
    return (config?.aiDefinitions || []).map((definition) => {
        return {
            value: definition.id,
            label: definition.name,
        };
    });
}

/**
 * Pick the form's keys out of the config, which drops both the hidden ones and any key this build
 * no longer supports (a setting removed in a later version, or one written by a newer build the
 * user ran earlier). The form renders a row per key present in the value it's given, not per schema
 * property, so an unsupported key left in here would show up as an editable row.
 */
function toJsonValue(config: Readonly<Config>): JsonValue {
    const visible = pickObjectKeys(config as Readonly<Record<string, unknown>>, formConfigKeys);
    return JSON.parse(JSON.stringify(visible)) as JsonValue;
}

function fromJsonValue(value: JsonValue, current: Readonly<Config>): Config {
    /**
     * Everything the form didn't see comes back from the current config: the hidden fields, and the
     * unsupported keys `toJsonValue` stripped. Without this the form's output would lack those keys
     * and saving would revert them to defaults — or, for an unsupported key, erase it from the file
     * of whichever build still uses it.
     */
    return {
        ...defaultConfig,
        ...omitObjectKeys(current as Readonly<Record<string, unknown>>, formConfigKeys),
        ...(value as Partial<Config>),
    };
}

export const VirSettingsModal = defineElement<{
    open: boolean;
}>()({
    tagName: 'vir-settings-modal',
    options: {
        errorHandler: reportRenderError,
    },
    events: {
        /**
         * Emitted when the user dismisses the modal (clicks the underlying scrim, hits Cancel /
         * Save, etc.). The parent owns the `open` input and is responsible for flipping it false.
         */
        closeRequested: defineElementEvent<void>(),
        /**
         * Asks the app to open the "Define AI" modal. Raised rather than rendering that modal here
         * so the two never stack on top of each other.
         */
        defineAiRequested: defineElementEvent<void>(),
    },
    state() {
        return {
            /**
             * Client-only terminal scrollback cap, backed by `localStorage` rather than the backend
             * config (so it's deliberately not part of the `ViraJsonForm` below). Seeded from the
             * persisted value and written straight back on every change.
             */
            scrollbackLimit: localStorageClient.scrollbackLimit.read(),
            pending: undefined as JsonValue | undefined,
            /**
             * Snapshot of the Config we loaded from the backend. Needed at save() time so we can
             * preserve the backend-managed fields (stripped from the user-facing form) when merging
             * the form's output back into a full Config.
             */
            loaded: undefined as Config | undefined,
            /**
             * Tracked apart from `loaded` because the default AI can also be changed by the "Define
             * AI" modal while this one sits open; save() re-reads config and applies just this
             * field on top, so the two can't clobber each other.
             */
            defaultAiId: undefined as string | undefined,
            /**
             * Same arrangement as `defaultAiId`: rendered outside the JSON form, so save() applies
             * it on top of the form's output. An empty string is a real value here (the user
             * clearing the path to go back to http), which is why save() merges it with `??`.
             */
            tlsCertPath: undefined as string | undefined,
            /** Set by save() when the backend reports no file at the saved certificate path. */
            tlsCertPathError: undefined as string | undefined,
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

        /* Holds the form and its per-field error together so the error reads as attached to the
           input above it rather than sitting a full body gap away. */
        .field-column {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .field-error {
            font-size: 12px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
        }

        .loading {
            padding: 24px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
        }

        /* Default-AI picker and its escape hatch to the "Define AI" modal, kept on one line so the
           button reads as an action on the same subject as the select. */
        .ai-row {
            display: flex;
            align-items: flex-end;
            gap: 8px;
        }

        .section-divider {
            border: none;
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            margin: 0;
            width: 100%;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        function reset() {
            updateState({
                pending: undefined,
                loaded: undefined,
                defaultAiId: undefined,
                tlsCertPath: undefined,
                tlsCertPathError: undefined,
                useWebgl: undefined,
                loadError: undefined,
                saveError: undefined,
                saving: false,
                restartingDaemon: false,
                daemonRestartError: undefined,
            });
        }

        async function restartDaemonAction() {
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
        }

        async function load() {
            try {
                const config = await getConfig();
                updateState({
                    pending: toJsonValue(config),
                    loaded: config,
                    defaultAiId: config.defaultAiId,
                    tlsCertPath: config.tlsCertPath || '',
                    // optionalShape default is true; coerce undefined → true for comparison.
                    useWebgl: config.useWebgl,
                    loadError: undefined,
                });
            } catch (error: unknown) {
                updateState({
                    loadError: error instanceof Error ? error.message : String(error),
                });
            }
        }

        async function save() {
            if (!state.pending || state.saving) {
                return;
            }
            updateState({
                saving: true,
                saveError: undefined,
                tlsCertPathError: undefined,
            });
            try {
                /**
                 * Re-read rather than trusting the load-time snapshot: the sidebar and the "Define
                 * AI" modal write config too, and the hidden keys this form preserves would
                 * otherwise be whatever they were when the modal opened.
                 */
                const current = await getConfig();
                const next: Config = {
                    ...fromJsonValue(state.pending, current),
                    defaultAiId: state.defaultAiId ?? current.defaultAiId,
                    tlsCertPath: state.tlsCertPath ?? current.tlsCertPath,
                };
                await putConfig(next);
                /**
                 * Checked after the write, not before it: the certificate lives on the server's
                 * filesystem, so only the backend can stat it, and a typo here shouldn't cost the
                 * user every other edit in the form. The modal stays open on a miss so the path can
                 * be corrected in place.
                 */
                if (next.tlsCertPath) {
                    const {resolvedPath, exists} = await checkPath({
                        path: next.tlsCertPath,
                    });
                    if (!exists) {
                        updateState({
                            saving: false,
                            tlsCertPathError: `No file found at ${resolvedPath}`,
                        });
                        return;
                    }
                }
                const nextUseWebgl = next.useWebgl;
                const webglChanged = state.useWebgl != undefined && state.useWebgl !== nextUseWebgl;
                reset();
                dispatch(
                    new events.closeRequested({
                        detail: undefined,
                    }),
                );
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
        }

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: 'Settings',
            })}
                ${listen(ViraModal.events.modalClose, () => {
                    reset();
                    dispatch(
                        new events.closeRequested({
                            detail: undefined,
                        }),
                    );
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
                              <div class="field-column">
                                  <${ViraForm.assign({
                                      fields: {
                                          scrollbackLimit: {
                                              type: ViraFormFieldType.Number,
                                              label: 'Terminal scrollback limit (lines)',
                                              value: state.scrollbackLimit,
                                              min: scrollbackLimit.min,
                                              max: scrollbackLimit.max,
                                              step: 1000,
                                          },
                                          tlsCertPath: {
                                              type: ViraFormFieldType.Text,
                                              label: 'HTTPS certificate path',
                                              value: state.tlsCertPath ?? '',
                                              placeholder: 'Leave empty to serve over http',
                                              hasError: !!state.tlsCertPathError,
                                          },
                                      },
                                  })}
                                      ${listen(ViraForm.events.valueChange, (event) => {
                                          if (event.detail.key === 'tlsCertPath') {
                                              updateState({
                                                  tlsCertPath: check.isString(event.detail.value)
                                                      ? event.detail.value
                                                      : '',
                                                  tlsCertPathError: undefined,
                                              });
                                              return;
                                          }
                                          const nextValue = event.detail.value;
                                          if (
                                              typeof nextValue !== 'number' ||
                                              !Number.isFinite(nextValue)
                                          ) {
                                              return;
                                          }
                                          const clamped = Math.min(
                                              scrollbackLimit.max,
                                              Math.max(scrollbackLimit.min, Math.round(nextValue)),
                                          );
                                          updateState({
                                              scrollbackLimit: clamped,
                                          });
                                          localStorageClient.scrollbackLimit.write(clamped);
                                      })}
                                  ></${ViraForm}>
                                  ${state.tlsCertPathError
                                      ? html`
                                            <div class="field-error">${state.tlsCertPathError}</div>
                                        `
                                      : ''}
                              </div>
                              <div class="ai-row">
                                  <${ViraSelect.assign({
                                      label: 'Default AI',
                                      options: aiOptions(state.loaded),
                                      value: state.defaultAiId || '',
                                      disabled: state.saving || !state.loaded,
                                  })}
                                      ${listen(ViraSelect.events.valueChange, (event) => {
                                          return updateState({
                                              defaultAiId: event.detail,
                                          });
                                      })}
                                  ></${ViraSelect}>
                                  <${ViraButton.assign({
                                      text: 'Define AI',
                                      buttonEmphasis: ViraEmphasis.Subtle,
                                      color: ViraColorVariant.Neutral,
                                      isDisabled: state.saving,
                                  })}
                                      ${listen('click', () => {
                                          return dispatch(
                                              new events.defineAiRequested({
                                                  detail: undefined,
                                              }),
                                          );
                                      })}
                                  ></${ViraButton}>
                              </div>
                              <hr class="section-divider" />
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
                                          dispatch(
                                              new events.closeRequested({
                                                  detail: undefined,
                                              }),
                                          );
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
