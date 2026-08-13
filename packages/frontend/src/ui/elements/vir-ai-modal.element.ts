import {type AiDefinition, type Config} from '@agent-storm/common';
import {createCuid2} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {
    css,
    defineElement,
    defineElementEvent,
    html,
    listen,
    onDomCreated,
    repeat,
} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraInput,
    ViraModal,
    ViraSelect,
    type ViraSelectOption,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {resizeImageForAvatar} from '../../util/ai-avatar.js';
import {getConfig, putConfig, uploadAiAvatar} from '../../util/api-client.js';
import {reportRenderError} from '../../util/client-error-log.js';
import {VirAiAvatar} from './vir-ai-avatar.element.js';

/** The editor's working copy of one AI. `id` is empty while adding, and assigned on save. */
type AiDraft = {
    id: string;
    name: string;
    resumeSessionCommand: string;
    newSessionCommand: string;
    avatarFile: string;
};

function toDraft(definition: Readonly<AiDefinition>): AiDraft {
    return {
        ...definition,
        avatarFile: definition.avatarFile || '',
    };
}

function emptyDraft(): AiDraft {
    return {
        id: '',
        name: '',
        resumeSessionCommand: '',
        newSessionCommand: '',
        avatarFile: '',
    };
}

/**
 * Defines the AIs every folder and tab picks from: a name, the command that resumes a conversation,
 * the command that starts a new one, and an optional avatar.
 *
 * Writes through `/config` like the settings modal does, rather than owning an endpoint of its own
 * — the definitions are config, and going through the same door keeps normalization (pruning
 * overrides that pointed at a deleted AI, dropping orphaned avatar files) in one place on the
 * backend.
 */
export const VirAiModal = defineElement<{
    open: boolean;
}>()({
    tagName: 'vir-ai-modal',
    options: {
        errorHandler: reportRenderError,
    },
    events: {
        closeRequested: defineElementEvent<void>(),
        /** Emitted after a successful save so the app can re-read anything derived from config. */
        configSaved: defineElementEvent<void>(),
    },
    state() {
        return {
            loaded: undefined as Config | undefined,
            requested: false,
            /** Undefined while showing the list; set to a draft while adding or editing one AI. */
            draft: undefined as AiDraft | undefined,
            dragging: false,
            saving: false,
            error: undefined as string | undefined,
        };
    },
    styles: css`
        .body {
            display: flex;
            flex-direction: column;
            gap: 12px;
            min-width: 340px;
            max-width: 520px;
        }

        .list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 6px 8px;
            border-radius: 6px;
        }

        .row:hover {
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .row-text {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            gap: 2px;
        }

        .row-name {
            font-weight: 600;
        }

        .row-command {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .row-actions {
            display: flex;
            gap: 4px;
        }

        .editor {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .avatar-row {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .drop-zone {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            align-items: center;
            gap: 4px;
            padding: 12px;
            border: 1px dashed ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            border-radius: 6px;
            text-align: center;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .drop-zone[data-dragging] {
            border-color: ${viraThemeByKeys.blue.foreground.decoration.foreground.value};
            color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
        }

        .empty {
            padding: 4px 2px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .error {
            padding: 8px 12px;
            border: 1px solid currentColor;
            border-radius: 6px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            background: ${viraThemeByKeys.red['behind-bg'].body.background.value};
            white-space: pre-wrap;
        }

        .footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        const reset = () => {
            updateState({
                loaded: undefined,
                requested: false,
                draft: undefined,
                dragging: false,
                saving: false,
                error: undefined,
            });
        };

        const load = async () => {
            try {
                updateState({
                    loaded: await getConfig(),
                    error: undefined,
                });
            } catch (error: unknown) {
                updateState({
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };

        /**
         * Persist a new definition list. Re-reads config first so a save can't clobber changes made
         * elsewhere (the sidebar writes config for folder overrides and view options) between the
         * modal opening and the user hitting Save.
         */
        const saveDefinitions = async (aiDefinitions: ReadonlyArray<Readonly<AiDefinition>>) => {
            updateState({
                saving: true,
                error: undefined,
            });
            try {
                const current = await getConfig();
                const saved = await putConfig({
                    ...current,
                    aiDefinitions: [...aiDefinitions],
                    /** First definition becomes the default when nothing was set yet. */
                    defaultAiId: current.defaultAiId || aiDefinitions[0]?.id || '',
                });
                updateState({
                    loaded: saved,
                    draft: undefined,
                    saving: false,
                });
                dispatch(new events.configSaved());
            } catch (error: unknown) {
                updateState({
                    saving: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const submitDraft = () => {
            const draft = state.draft;
            if (!draft || state.saving) {
                return;
            }
            const name = draft.name.trim();
            const resumeSessionCommand = draft.resumeSessionCommand.trim();
            if (!name || !resumeSessionCommand) {
                updateState({
                    error: 'An AI needs a name and a resume session command.',
                });
                return;
            }
            const definition: AiDefinition = {
                id: draft.id || createCuid2(),
                name,
                resumeSessionCommand,
                newSessionCommand: draft.newSessionCommand.trim(),
                ...(draft.avatarFile
                    ? {
                          avatarFile: draft.avatarFile,
                      }
                    : {}),
            };
            const existing = state.loaded?.aiDefinitions || [];
            void saveDefinitions(
                draft.id
                    ? existing.map((entry) => (entry.id === draft.id ? definition : entry))
                    : [
                          ...existing,
                          definition,
                      ],
            );
        };

        const deleteDefinition = (definition: Readonly<AiDefinition>) => {
            if (
                !window.confirm(
                    `Delete "${definition.name}"? Folders and tabs using it fall back to the default AI.`,
                )
            ) {
                return;
            }
            void saveDefinitions(
                (state.loaded?.aiDefinitions || []).filter((entry) => entry.id !== definition.id),
            );
        };

        const applyAvatarFile = async (file: Readonly<Blob> | undefined) => {
            if (!file || !state.draft) {
                return;
            }
            updateState({
                dragging: false,
                error: undefined,
            });
            try {
                updateDraft({
                    avatarFile: await uploadAiAvatar(await resizeImageForAvatar(file)),
                });
            } catch (error: unknown) {
                updateState({
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };

        const updateDraft = (changes: Readonly<Partial<AiDraft>>) => {
            updateState({
                draft: state.draft && {
                    ...state.draft,
                    ...changes,
                },
            });
        };

        /**
         * Other AIs whose avatar this draft can borrow, so a second `claude` variant doesn't need
         * the user to find the same image file again. The draft itself is excluded — copying its
         * own avatar onto itself does nothing. A lone placeholder entry means there's nothing to
         * copy, and the whole control is dropped.
         */
        const avatarSourceOptions: ViraSelectOption[] = [
            {
                value: '',
                label: 'Pick an AI...',
            },
            ...(state.loaded?.aiDefinitions || [])
                .filter(
                    (definition) =>
                        definition.avatarFile &&
                        definition.id !== state.draft?.id &&
                        definition.avatarFile !== state.draft?.avatarFile,
                )
                .map((definition) => {
                    return {
                        value: definition.id,
                        label: definition.name,
                    };
                }),
        ];

        const renderEditor = (draft: Readonly<AiDraft>) => html`
            <div class="editor">
                <${ViraInput.assign({
                    label: 'Name',
                    value: draft.name,
                    placeholder: 'Claude',
                    showClearButton: true,
                    disabled: state.saving,
                })}
                    ${listen(ViraInput.events.valueChange, (event) =>
                        updateDraft({
                            name: event.detail,
                        }),
                    )}
                ></${ViraInput}>
                <${ViraInput.assign({
                    label: 'Resume session command',
                    value: draft.resumeSessionCommand,
                    placeholder: 'claude --continue',
                    showClearButton: true,
                    disableBrowserHelps: true,
                    disabled: state.saving,
                })}
                    ${listen(ViraInput.events.valueChange, (event) =>
                        updateDraft({
                            resumeSessionCommand: event.detail,
                        }),
                    )}
                ></${ViraInput}>
                <${ViraInput.assign({
                    label: 'New session command',
                    value: draft.newSessionCommand,
                    placeholder: 'claude',
                    showClearButton: true,
                    disableBrowserHelps: true,
                    disabled: state.saving,
                })}
                    ${listen(ViraInput.events.valueChange, (event) =>
                        updateDraft({
                            newSessionCommand: event.detail,
                        }),
                    )}
                ></${ViraInput}>
                <div class="avatar-row">
                    <${VirAiAvatar.assign({
                        name: draft.name,
                        avatarFile: draft.avatarFile,
                        sizePx: 48,
                    })}></${VirAiAvatar}>
                    <div
                        class="drop-zone"
                        ?data-dragging=${state.dragging}
                        ${listen('dragover', (event) => {
                            event.preventDefault();
                            if (!state.dragging) {
                                updateState({
                                    dragging: true,
                                });
                            }
                        })}
                        ${listen('dragleave', () =>
                            updateState({
                                dragging: false,
                            }),
                        )}
                        ${listen('drop', (event) => {
                            event.preventDefault();
                            void applyAvatarFile(event.dataTransfer?.files[0]);
                        })}
                    >
                        <span>Drop an image here for the avatar</span>
                        <input
                            type="file"
                            accept="image/*"
                            ?disabled=${state.saving}
                            ${listen('change', (event) => {
                                const input = extractEventTarget(event, HTMLInputElement);
                                void applyAvatarFile(input.files?.[0]);
                            })}
                        />
                    </div>
                    ${draft.avatarFile
                        ? html`
                              <${ViraButton.assign({
                                  text: 'Remove',
                                  buttonSize: ViraSize.Small,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  color: ViraColorVariant.Neutral,
                                  isDisabled: state.saving,
                              })}
                                  ${listen('click', () =>
                                      updateDraft({
                                          avatarFile: '',
                                      }),
                                  )}
                              ></${ViraButton}>
                          `
                        : ''}
                </div>
                ${avatarSourceOptions.length > 1
                    ? html`
                          <${ViraSelect.assign({
                              label: 'Copy avatar from',
                              options: avatarSourceOptions,
                              /**
                               * Always shows the placeholder: picking an entry is an action that
                               * copies its image onto this draft, not a value this draft holds.
                               */
                              value: '',
                              disabled: state.saving,
                          })}
                              ${listen(ViraSelect.events.valueChange, (event) => {
                                  const source = (state.loaded?.aiDefinitions || []).find(
                                      (definition) => definition.id === event.detail,
                                  );
                                  if (source?.avatarFile) {
                                      updateDraft({
                                          avatarFile: source.avatarFile,
                                      });
                                  }
                              })}
                          ></${ViraSelect}>
                      `
                    : ''}
                <div class="footer">
                    <${ViraButton.assign({
                        text: 'Cancel',
                        buttonEmphasis: ViraEmphasis.Subtle,
                        color: ViraColorVariant.Neutral,
                        isDisabled: state.saving,
                    })}
                        ${listen('click', () =>
                            updateState({
                                draft: undefined,
                                error: undefined,
                            }),
                        )}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: state.saving ? 'Saving...' : 'Save',
                        color: ViraColorVariant.Brand,
                        isDisabled: state.saving,
                    })}
                        ${listen('click', submitDraft)}
                    ></${ViraButton}>
                </div>
            </div>
        `;

        const renderList = (definitions: ReadonlyArray<Readonly<AiDefinition>>) => html`
            <div class="list">
                ${repeat(
                    definitions,
                    (definition) => definition.id,
                    (definition) => html`
                        <div class="row">
                            <${VirAiAvatar.assign({
                                name: definition.name,
                                avatarFile: definition.avatarFile || '',
                                sizePx: 28,
                            })}></${VirAiAvatar}>
                            <span class="row-text">
                                <span class="row-name">${definition.name}</span>
                                <span class="row-command">${definition.resumeSessionCommand}</span>
                            </span>
                            <span class="row-actions">
                                <${ViraButton.assign({
                                    text: 'Edit',
                                    buttonSize: ViraSize.Small,
                                    buttonEmphasis: ViraEmphasis.Subtle,
                                    color: ViraColorVariant.Neutral,
                                    isDisabled: state.saving,
                                })}
                                    ${listen('click', () =>
                                        updateState({
                                            draft: toDraft(definition),
                                            error: undefined,
                                        }),
                                    )}
                                ></${ViraButton}>
                                <${ViraButton.assign({
                                    text: 'Delete',
                                    buttonSize: ViraSize.Small,
                                    buttonEmphasis: ViraEmphasis.Subtle,
                                    color: ViraColorVariant.Danger,
                                    isDisabled: state.saving,
                                })}
                                    ${listen('click', () => deleteDefinition(definition))}
                                ></${ViraButton}>
                            </span>
                        </div>
                    `,
                )}
            </div>
            ${definitions.length
                ? ''
                : html`
                      <div class="empty">No AI defined yet.</div>
                  `}
            <div class="footer">
                <${ViraButton.assign({
                    text: 'Add AI',
                    color: ViraColorVariant.Brand,
                    isDisabled: state.saving,
                })}
                    ${listen('click', () =>
                        updateState({
                            draft: emptyDraft(),
                            error: undefined,
                        }),
                    )}
                ></${ViraButton}>
            </div>
        `;

        return html`
            <${ViraModal.assign({
                open: inputs.open,
                modalTitle: state.draft ? 'Define AI' : 'Defined AIs',
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
                                  if (!state.requested) {
                                      updateState({
                                          requested: true,
                                      });
                                      void load();
                                  }
                              })}
                          >
                              ${state.error
                                  ? html`
                                        <div class="error">${state.error}</div>
                                    `
                                  : ''}
                              ${state.draft
                                  ? renderEditor(state.draft)
                                  : state.loaded
                                    ? renderList(state.loaded.aiDefinitions)
                                    : html`
                                          <div class="empty">Loading...</div>
                                      `}
                          </div>
                      `
                    : ''}
            </${ViraModal}>
        `;
    },
});
