import {type Settings} from '@agent-storm/common';
import {
    defineAppElement,
    settingsCardCss,
    VirSettingsRow,
    type AppContext,
    type ValueUpdate,
} from '@agent-storm/core/frontend';
import {extractErrorMessage, getEnumValues, omitObjectKeys} from '@augment-vir/common';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {ViraDropdown} from 'vira';
import {AiProvider, providerLabels, ReasoningEffort} from '../../build-v2-api.js';
import {buildV2Client} from '../../util/build-v2-client.js';
import {findThreadRepos} from '../../util/build-v2-state.js';
import {
    readModelDefaults,
    writeModelDefaults,
    type ModelDefault,
    type ModelDefaults,
} from '../../util/model-defaults.js';
import {readEffectiveEffort, reasoningEffortLabels} from '../../util/reasoning-effort.js';
import {type ProviderModelList} from './vir-ai-chat-model-picker.element.js';

/** Joins a provider and a model id into one dropdown value. An empty model id is the default. */
function toModelOptionValue({provider, model}: Readonly<Pick<ModelDefault, 'provider' | 'model'>>) {
    return `${provider}/${model}`;
}

/**
 * The Settings modal's editor for the model and effort new AI chats start with: the global default,
 * or with `folderPicker` set, a folder's.
 */
export const VirAiChatModelDefaults = defineAppElement<{
    context: AppContext;
    settings: Readonly<Settings>;
    /** Set to edit a folder's default instead of the global one. */
    folderPicker:
        | Readonly<{
              /** Undefined until one is picked. */
              folder: string | undefined;
          }>
        | undefined;
}>()({
    tagName: 'vir-ai-chat-model-defaults',
    events: {
        settingsChange: defineElementEvent<ValueUpdate<Settings>>(),
        folderSelect: defineElementEvent<string>(),
    },
    state() {
        return {
            providerModels: {} as Readonly<Partial<Record<AiProvider, ProviderModelList>>>,
        };
    },
    init({updateState, host}) {
        getEnumValues(AiProvider).forEach((provider) => {
            buildV2Client
                .call('listModels', {
                    provider,
                })
                .then(({models}) => {
                    updateState({
                        providerModels: {
                            ...host.instanceState.providerModels,
                            [provider]: {
                                models,
                            },
                        },
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        providerModels: {
                            ...host.instanceState.providerModels,
                            [provider]: {
                                errorMessage: extractErrorMessage(error),
                            },
                        },
                    });
                });
        });
    },
    styles: css`
        ${settingsCardCss}

        :host {
            display: flex;
            flex-direction: column;
        }
    `,
    render({inputs, state, dispatch, events}) {
        const defaults = readModelDefaults(inputs.settings);
        const folder = inputs.folderPicker?.folder;
        const value = inputs.folderPicker
            ? folder
                ? defaults.folders[folder]
                : undefined
            : defaults.global || undefined;
        const models = getEnumValues(AiProvider).flatMap((provider) => {
            const list = state.providerModels[provider];
            return list && 'models' in list
                ? list.models.map((model) => {
                      return {
                          provider,
                          model,
                      };
                  })
                : [];
        });
        const selectedModel = value
            ? models.find((entry) => {
                  return (
                      entry.provider === value.provider &&
                      (value.model ? entry.model.id === value.model : entry.model.isDefault)
                  );
              })?.model
            : undefined;
        const unsetDescription = inputs.folderPicker
            ? 'Unset, new chats here use the global default until your next pick in one sets this.'
            : 'Unset, your next pick in any AI chat sets this.';

        function changeDefault(newValue: Readonly<ModelDefault> | undefined) {
            dispatch(
                new events.settingsChange({
                    detail(current) {
                        const currentDefaults = readModelDefaults(current);
                        const updated: ModelDefaults = folder
                            ? {
                                  ...currentDefaults,
                                  folders: newValue
                                      ? {
                                            ...currentDefaults.folders,
                                            [folder]: newValue,
                                        }
                                      : omitObjectKeys(currentDefaults.folders, [
                                            folder,
                                        ]),
                              }
                            : {
                                  ...currentDefaults,
                                  global: newValue,
                              };
                        return writeModelDefaults({
                            settings: current,
                            defaults: updated,
                        });
                    },
                }),
            );
        }

        const folderRow = inputs.folderPicker
            ? html`
                  <${VirSettingsRow.assign({
                      rowTitle: 'Folder',
                      description: 'The folder whose AI chat default to change.',
                  })}>
                      <${ViraDropdown.assign({
                          options: findThreadRepos(inputs.context)
                              .map((repo) => {
                                  return {
                                      value: repo.path,
                                      label: repo.name,
                                  };
                              })
                              .toSorted((first, second) => first.label.localeCompare(second.label)),
                          selected: folder
                              ? [
                                    folder,
                                ]
                              : [],
                          placeholder: 'Pick a folder...',
                          isSearchable: true,
                      })}
                          ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                              const path = event.detail[0];
                              if (path) {
                                  dispatch(
                                      new events.folderSelect({
                                          detail: path,
                                      }),
                                  );
                              }
                          })}
                      ></${ViraDropdown}>
                  </${VirSettingsRow}>
              `
            : nothing;

        const efforts = selectedModel?.supportedEfforts || [];
        const selectedEffort = readEffectiveEffort({
            model: selectedModel,
            effort: value?.effort || undefined,
        });
        const effortRow =
            value && efforts.length
                ? html`
                      <${VirSettingsRow.assign({
                          rowTitle: 'Effort',
                          description: 'How much the model thinks before it answers.',
                      })}>
                          <${ViraDropdown.assign({
                              options: efforts.map((effort) => {
                                  return {
                                      value: effort,
                                      label: reasoningEffortLabels[effort],
                                  };
                              }),
                              selected: selectedEffort
                                  ? [
                                        selectedEffort,
                                    ]
                                  : [],
                          })}
                              ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                                  const effort = getEnumValues(ReasoningEffort).find((entry) => {
                                      return entry === event.detail[0];
                                  });
                                  changeDefault({
                                      ...value,
                                      effort,
                                  });
                              })}
                          ></${ViraDropdown}>
                      </${VirSettingsRow}>
                  `
                : nothing;

        const modelRows =
            inputs.folderPicker && !folder
                ? nothing
                : html`
                      <${VirSettingsRow.assign({
                          rowTitle: 'Model',
                          description: value
                              ? 'The model a new AI chat starts with.'
                              : unsetDescription,
                          isModified: !!value,
                      })}
                          ${listen(VirSettingsRow.events.reset, () => {
                              changeDefault(undefined);
                          })}
                      >
                          <${ViraDropdown.assign({
                              options: models.map((entry) => {
                                  return {
                                      value: toModelOptionValue({
                                          provider: entry.provider,
                                          model: entry.model.isDefault ? '' : entry.model.id,
                                      }),
                                      label: `${providerLabels[entry.provider]}: ${entry.model.name}`,
                                  };
                              }),
                              selected: value
                                  ? [
                                        toModelOptionValue(value),
                                    ]
                                  : [],
                              placeholder: 'Not set',
                              isSearchable: true,
                          })}
                              ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                                  const picked = models.find((entry) => {
                                      return (
                                          toModelOptionValue({
                                              provider: entry.provider,
                                              model: entry.model.isDefault ? '' : entry.model.id,
                                          }) === event.detail[0]
                                      );
                                  });
                                  if (!picked) {
                                      return;
                                  }
                                  changeDefault({
                                      provider: picked.provider,
                                      model: picked.model.isDefault ? '' : picked.model.id,
                                      effort: readEffectiveEffort({
                                          model: picked.model,
                                          effort: value?.effort || undefined,
                                      }),
                                  });
                              })}
                          ></${ViraDropdown}>
                      </${VirSettingsRow}>
                      ${effortRow}
                  `;

        return html`
            <div class="card">${folderRow} ${modelRows}</div>
        `;
    },
});
