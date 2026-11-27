import {ThreadOrigin, type Settings} from '@agent-storm/common';
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
import {AiProvider} from '../../build-api.js';
import {buildClient} from '../../util/build-client.js';
import {findThreadRepos} from '../../util/build-state.js';
import {
    originModelFallbacks,
    readModelDefaults,
    writeModelDefaults,
    type ModelDefault,
    type ModelDefaults,
} from '../../util/model-default-settings.js';
import {VirAiChatModelPicker, type ProviderModelList} from './vir-ai-chat-model-picker.element.js';

/** The background threads whose model the Settings modal can set. */
export const pluginThreadModelLabels: Readonly<
    Record<ThreadOrigin.Review | ThreadOrigin.Watch | ThreadOrigin.SelfImprove, string>
> = {
    [ThreadOrigin.Review]: 'Manual review model',
    [ThreadOrigin.Watch]: 'Watch mode model',
    [ThreadOrigin.SelfImprove]: 'Self-improvement model',
};

/**
 * The Settings modal's editor for the model and effort new AI chats start with: the global default,
 * with `folderPicker` set a folder's, or with `origin` set the model a plugin's threads run on.
 */
export const VirAiChatModelDefaults = defineAppElement<{
    context: AppContext;
    settings: Readonly<Settings>;
    /** Set to edit the model of background threads instead of a chat default. */
    origin: keyof typeof pluginThreadModelLabels | undefined;
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
            buildClient
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
        const origin = inputs.origin;
        const value = origin
            ? defaults.origins?.[origin]
            : inputs.folderPicker
              ? folder
                  ? defaults.folders[folder]
                  : undefined
              : defaults.global || undefined;
        const originFallback = origin ? originModelFallbacks[origin] : undefined;
        const unsetDescription = origin
            ? originFallback
                ? 'Unset, these threads run on the model shown.'
                : "Unset, these threads start on their folder's AI chat default."
            : inputs.folderPicker
              ? 'Unset, new chats here use the global default until your next pick in one sets this.'
              : 'Unset, your next pick in any AI chat sets this.';

        function changeDefault(newValue: Readonly<ModelDefault> | undefined) {
            dispatch(
                new events.settingsChange({
                    detail(current) {
                        const currentDefaults = readModelDefaults(current);
                        const updated: ModelDefaults = origin
                            ? {
                                  ...currentDefaults,
                                  origins: newValue
                                      ? {
                                            ...currentDefaults.origins,
                                            [origin]: newValue,
                                        }
                                      : omitObjectKeys(currentDefaults.origins || {}, [
                                            origin,
                                        ]),
                              }
                            : folder
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

        /** An unset default shows what it falls back to. */
        const shown = value || originFallback || defaults.global;
        const modelRows =
            inputs.folderPicker && !folder
                ? nothing
                : html`
                      <${VirSettingsRow.assign({
                          rowTitle: origin ? pluginThreadModelLabels[origin] : 'Model',
                          description: value
                              ? origin
                                  ? 'The model these threads run on, including ones already started.'
                                  : 'The model a new AI chat starts with.'
                              : unsetDescription,
                          isModified: !!value,
                      })}
                          ${listen(VirSettingsRow.events.reset, () => {
                              changeDefault(undefined);
                          })}
                      >
                          <${VirAiChatModelPicker.assign({
                              providerModels: state.providerModels,
                              provider: shown?.provider || AiProvider.Claude,
                              model: shown?.model || '',
                              effort: shown?.effort || undefined,
                              speedTier: shown?.speedTier || undefined,
                              isDisabled: false,
                          })}
                              ${listen(VirAiChatModelPicker.events.modelChange, (event) => {
                                  changeDefault(event.detail);
                              })}
                          ></${VirAiChatModelPicker}>
                      </${VirSettingsRow}>
                  `;

        return html`
            <div class="card">${folderRow} ${modelRows}</div>
        `;
    },
});
