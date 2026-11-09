import {aiAvatarUploadEndpoint, type AiDefinition, type Settings} from '@agent-storm/common';
import {
    defineAppElement,
    fetchApi,
    resizeImageForAvatar,
    settingsCardCss,
    VirAiAvatar,
    VirSettingsRow,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {createCuid2, extractErrorMessage} from '@augment-vir/common';
import {extractEventTarget} from '@augment-vir/web';
import {HttpMethod} from '@rest-vir/api';
import {css, defineElementEvent, html, listen, nothing, repeat} from 'element-vir';
import {
    ViraButton,
    ViraColorVariant,
    ViraDropdown,
    ViraEmphasis,
    ViraInput,
    ViraSize,
    viraThemeByKeys,
    type ViraDropdownOption,
} from 'vira';

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
 * The Settings modal's AI section: the default AI, and the AIs every folder and tab picks from,
 * each with a name, the command that resumes a conversation, the command that starts a new one, and
 * an optional avatar. An AI being edited is a draft that only applies on Save.
 */
export const VirSettingsAi = defineAppElement<{
    settings: Readonly<Settings>;
}>()({
    tagName: 'vir-settings-ai',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
    },
    state() {
        return {
            /** Undefined while showing the list; set to a draft while adding or editing one AI. */
            draft: undefined as AiDraft | undefined,
            dragging: false,
            error: '',
        };
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .ai {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 16px;
        }

        .ai-text {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            gap: 2px;
        }

        .ai-name {
            font-weight: 600;
        }

        .ai-command {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: ui-monospace, monospace;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        .actions {
            display: flex;
            justify-content: flex-end;
            gap: 4px;
        }

        .editor {
            display: flex;
            flex-direction: column;
            gap: 10px;
            padding: 16px;
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

        .error {
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            white-space: pre-wrap;
        }
    `,
    render({inputs, state, updateState, dispatch, events}) {
        function changeSettings(update: ValueUpdate<Settings>) {
            dispatch(
                new events.settingsChange({
                    detail: update,
                }),
            );
        }

        function changeDefinitions(
            update: (definitions: ReadonlyArray<Readonly<AiDefinition>>) => AiDefinition[],
        ) {
            changeSettings((current) => {
                const aiDefinitions = update(current.aiDefinitions);
                return {
                    ...current,
                    aiDefinitions,
                    /** The first definition becomes the default when nothing was set yet. */
                    defaultAiId: current.defaultAiId || aiDefinitions[0]?.id || '',
                };
            });
        }

        function submitDraft(draft: Readonly<AiDraft>) {
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
            changeDefinitions((definitions) => {
                return draft.id
                    ? definitions.map((entry) => (entry.id === draft.id ? definition : entry))
                    : [
                          ...definitions,
                          definition,
                      ];
            });
            updateState({
                draft: undefined,
                error: '',
            });
        }

        function deleteDefinition(definition: Readonly<AiDefinition>) {
            if (
                window.confirm(
                    `Delete "${definition.name}"? Folders and tabs using it fall back to the default AI.`,
                )
            ) {
                changeDefinitions((definitions) => {
                    return definitions.filter((entry) => entry.id !== definition.id);
                });
            }
        }

        function updateDraft(changes: Readonly<Partial<AiDraft>>) {
            updateState({
                draft: state.draft && {
                    ...state.draft,
                    ...changes,
                },
            });
        }

        async function applyAvatarFile(file: Readonly<Blob> | undefined) {
            if (!file || !state.draft) {
                return;
            }
            updateState({
                dragging: false,
                error: '',
            });
            try {
                updateDraft({
                    avatarFile: (
                        await fetchApi(aiAvatarUploadEndpoint, HttpMethod.Post, {
                            requestData: await resizeImageForAvatar(file),
                        })
                    ).avatarFile,
                });
            } catch (error: unknown) {
                updateState({
                    error: extractErrorMessage(error),
                });
            }
        }

        function renderEditor(draft: Readonly<AiDraft>) {
            /**
             * Other AIs whose avatar this draft can borrow, so a second `claude` variant doesn't
             * need the user to find the same image file again.
             */
            const avatarSourceOptions: ViraDropdownOption[] = inputs.settings.aiDefinitions
                .filter((definition) => {
                    return (
                        definition.avatarFile &&
                        definition.id !== draft.id &&
                        definition.avatarFile !== draft.avatarFile
                    );
                })
                .map((definition) => {
                    return {
                        value: definition.id,
                        label: definition.name,
                    };
                });

            return html`
                <span class="card-title">${draft.id ? 'Edit AI' : 'Add AI'}</span>
                <div class="card">
                    <div class="editor">
                        <${ViraInput.assign({
                            label: 'Name',
                            value: draft.name,
                            placeholder: 'Claude',
                            showClearButton: true,
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                updateDraft({
                                    name: event.detail,
                                });
                            })}
                        ></${ViraInput}>
                        <${ViraInput.assign({
                            label: 'Resume session command',
                            value: draft.resumeSessionCommand,
                            placeholder: 'claude --continue',
                            showClearButton: true,
                            disableBrowserHelps: true,
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                updateDraft({
                                    resumeSessionCommand: event.detail,
                                });
                            })}
                        ></${ViraInput}>
                        <${ViraInput.assign({
                            label: 'New session command',
                            value: draft.newSessionCommand,
                            placeholder: 'claude',
                            showClearButton: true,
                            disableBrowserHelps: true,
                        })}
                            ${listen(ViraInput.events.valueChange, (event) => {
                                updateDraft({
                                    newSessionCommand: event.detail,
                                });
                            })}
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
                                ${listen('dragleave', () => {
                                    updateState({
                                        dragging: false,
                                    });
                                })}
                                ${listen('drop', async (event) => {
                                    event.preventDefault();
                                    await applyAvatarFile(event.dataTransfer?.files[0]);
                                })}
                            >
                                <span>Drop an image here for the avatar</span>
                                <input
                                    type="file"
                                    accept="image/*"
                                    ${listen('change', async (event) => {
                                        const input = extractEventTarget(event, HTMLInputElement);
                                        await applyAvatarFile(input.files?.[0]);
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
                                      })}
                                          ${listen('click', () => {
                                              updateDraft({
                                                  avatarFile: '',
                                              });
                                          })}
                                      ></${ViraButton}>
                                  `
                                : nothing}
                        </div>
                        ${avatarSourceOptions.length
                            ? html`
                                  <${ViraDropdown.assign({
                                      label: 'Copy avatar from',
                                      options: avatarSourceOptions,
                                      /**
                                       * Always shows the placeholder: picking an entry is an action
                                       * that copies its image onto this draft, not a value this
                                       * draft holds.
                                       */
                                      placeholder: 'Pick an AI...',
                                      selected: [],
                                  })}
                                      ${listen(
                                          ViraDropdown.events.selectedValuesChange,
                                          (event) => {
                                              const source = inputs.settings.aiDefinitions.find(
                                                  (definition) => definition.id === event.detail[0],
                                              );
                                              if (source?.avatarFile) {
                                                  updateDraft({
                                                      avatarFile: source.avatarFile,
                                                  });
                                              }
                                          },
                                      )}
                                  ></${ViraDropdown}>
                              `
                            : nothing}
                        ${state.error
                            ? html`
                                  <span class="error">${state.error}</span>
                              `
                            : nothing}
                        <div class="actions">
                            <${ViraButton.assign({
                                text: 'Cancel',
                                buttonEmphasis: ViraEmphasis.Subtle,
                                color: ViraColorVariant.Neutral,
                            })}
                                ${listen('click', () => {
                                    updateState({
                                        draft: undefined,
                                        error: '',
                                    });
                                })}
                            ></${ViraButton}>
                            <${ViraButton.assign({
                                text: 'Save',
                                color: ViraColorVariant.Brand,
                            })}
                                ${listen('click', () => {
                                    submitDraft(draft);
                                })}
                            ></${ViraButton}>
                        </div>
                    </div>
                </div>
            `;
        }

        function renderList() {
            return html`
                <div class="card">
                    <${VirSettingsRow.assign({
                        rowTitle: 'Default AI',
                        description: 'Used by every folder that has no AI of its own.',
                    })}>
                        <${ViraDropdown.assign({
                            options: inputs.settings.aiDefinitions.map((definition) => {
                                return {
                                    value: definition.id,
                                    label: definition.name,
                                };
                            }),
                            selected: inputs.settings.defaultAiId
                                ? [
                                      inputs.settings.defaultAiId,
                                  ]
                                : [],
                            isDisabled: !inputs.settings.aiDefinitions.length,
                        })}
                            ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                                const defaultAiId = event.detail[0];
                                if (defaultAiId) {
                                    changeSettings((current) => {
                                        return {
                                            ...current,
                                            defaultAiId,
                                        };
                                    });
                                }
                            })}
                        ></${ViraDropdown}>
                    </${VirSettingsRow}>
                </div>
                <span class="card-title">Defined AIs</span>
                <div class="card">
                    ${repeat(
                        inputs.settings.aiDefinitions,
                        (definition) => definition.id,
                        (definition) => {
                            return html`
                                <div class="ai">
                                    <${VirAiAvatar.assign({
                                        name: definition.name,
                                        avatarFile: definition.avatarFile || '',
                                        sizePx: 28,
                                    })}></${VirAiAvatar}>
                                    <span class="ai-text">
                                        <span class="ai-name">${definition.name}</span>
                                        <span class="ai-command">
                                            ${definition.resumeSessionCommand}
                                        </span>
                                    </span>
                                    <span class="actions">
                                        <${ViraButton.assign({
                                            text: 'Edit',
                                            buttonSize: ViraSize.Small,
                                            buttonEmphasis: ViraEmphasis.Subtle,
                                            color: ViraColorVariant.Neutral,
                                        })}
                                            ${listen('click', () => {
                                                updateState({
                                                    draft: toDraft(definition),
                                                    error: '',
                                                });
                                            })}
                                        ></${ViraButton}>
                                        <${ViraButton.assign({
                                            text: 'Delete',
                                            buttonSize: ViraSize.Small,
                                            buttonEmphasis: ViraEmphasis.Subtle,
                                            color: ViraColorVariant.Danger,
                                        })}
                                            ${listen('click', () => {
                                                deleteDefinition(definition);
                                            })}
                                        ></${ViraButton}>
                                    </span>
                                </div>
                            `;
                        },
                    )}
                    ${inputs.settings.aiDefinitions.length
                        ? nothing
                        : html`
                              <div class="card-hint">No AI defined yet.</div>
                          `}
                </div>
                <div class="actions">
                    <${ViraButton.assign({
                        text: 'Add AI',
                        color: ViraColorVariant.Brand,
                    })}
                        ${listen('click', () => {
                            updateState({
                                draft: emptyDraft(),
                                error: '',
                            });
                        })}
                    ></${ViraButton}>
                </div>
            `;
        }

        return state.draft ? renderEditor(state.draft) : renderList();
    },
});
