import {defineAppElement, VirPaneGroup, type AppContext} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {createFullDateInUserTimezone} from 'date-vir';
import {css, html, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraEmphasis,
    ViraForm,
    ViraInput,
    ViraRelativeTime,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {
    BotState,
    type BotInfo,
    type BotQuestion,
    type BotRepo,
    type BotRun,
} from '../../bots-api.js';
import {addBotThreadTab} from '../../util/bot-tabs.js';
import {botsClient} from '../../util/bots-client.js';
import {
    BotSettingsField,
    createApiKeyField,
    createBotSettingsFields,
    readBotSettingsFields,
    type BotSettingsFields,
} from './bot-settings-fields.js';
import {botStateTags, renderTag, runStatusTags, runTriggerLabels} from './bots-display.js';
import {botViewStyles} from './bots-styles.js';

/** One bot in the Bots tab: its settings, questions, run history, and its shell and AI tabs. */
export const VirBotsBotView = defineAppElement<{
    context: AppContext;
    repo: Readonly<BotRepo>;
    bot: Readonly<BotInfo>;
    /** The bot's unanswered questions. */
    questions: ReadonlyArray<Readonly<BotQuestion>>;
    isShown: boolean;
}>()({
    tagName: 'vir-bots-bot-view',
    state() {
        return {
            fields: undefined as BotSettingsFields | undefined,
            runs: [] as ReadonlyArray<Readonly<BotRun>>,
            /** The bot's pane group, once its shell tab exists. */
            shell: undefined as Readonly<{folder: string; scope: string}> | undefined,
            /** What the user typed as each question's answer, by question id. */
            answers: {} as Readonly<Record<string, string>>,
            error: undefined as string | undefined,
            isBusy: false,
            removeRunsListener: undefined as (() => void) | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
        }

        ${botViewStyles}

        .view {
            flex-shrink: 0;
            max-height: 50%;
            overflow-y: auto;
            box-sizing: border-box;
        }

        .panes {
            flex-grow: 1;
            position: relative;
            min-height: 0;
            border-top: 1px solid
                ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        ${VirPaneGroup} {
            position: absolute;
            inset: 0;
        }

        .question,
        .run {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px;
            border-radius: 4px;
            background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
        }

        .question {
            background-color: ${viraThemeByKeys.yellow['behind-fg']['small-body'].background.value};
        }

        .runs {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        ul {
            margin: 0;
            padding-left: 20px;
        }
    `,
    init({inputs, updateState, host}) {
        function loadRuns() {
            botsClient
                .call('readRuns', {
                    botId: host.instanceInputs.bot.botId,
                })
                .then(({runs}) => {
                    updateState({
                        runs,
                    });
                })
                .catch((error: unknown) => {
                    updateState({
                        error: extractErrorMessage(error),
                    });
                });
        }

        updateState({
            fields: createBotSettingsFields(inputs.bot),
            removeRunsListener: botsClient.listen('runsChanged', ({botId}) => {
                if (botId === host.instanceInputs.bot.botId) {
                    loadRuns();
                }
            }),
        });
        loadRuns();
        botsClient
            .call('ensureBotShell', {
                botId: inputs.bot.botId,
            })
            .then((shell) => {
                updateState({
                    shell,
                });
            })
            .catch((error: unknown) => {
                updateState({
                    error: extractErrorMessage(error),
                });
            });
    },
    cleanup({state}) {
        state.removeRunsListener?.();
    },
    render({inputs, state, updateState, host}) {
        async function act(action: () => Promise<unknown>) {
            if (host.instanceState.isBusy) {
                return;
            }
            updateState({
                isBusy: true,
                error: undefined,
            });
            try {
                await action();
            } catch (error) {
                updateState({
                    error: extractErrorMessage(error),
                });
            } finally {
                updateState({
                    isBusy: false,
                });
            }
        }

        async function answer(questionId: string, answerText: string | undefined) {
            await act(async () => {
                await botsClient.call('answerQuestion', {
                    questionId,
                    answer: answerText,
                });
                updateState({
                    answers: omitObjectKeys(host.instanceState.answers, [
                        questionId,
                    ]),
                });
            });
        }

        function openThread(threadId: string) {
            addBotThreadTab({
                uiLayout: inputs.context.uiLayout,
                repoPath: inputs.repo.repoPath,
                botId: inputs.bot.botId,
                threadId,
                isShown: true,
            });
        }

        return html`
            <div class="view">
                <div class="header">
                    <h2>${inputs.bot.name}</h2>
                    ${renderTag(botStateTags[inputs.bot.state])}
                    <span class="faint">${inputs.repo.name}</span>
                    ${inputs.bot.nextRunAt
                        ? html`
                              <span class="faint">
                                  Next run
                                  <${ViraRelativeTime.assign({
                                      time: createFullDateInUserTimezone(inputs.bot.nextRunAt),
                                  })}></${ViraRelativeTime}>
                              </span>
                          `
                        : nothing}
                </div>
                ${inputs.bot.description
                    ? html`
                          <div>${inputs.bot.description}</div>
                      `
                    : nothing}
                ${inputs.bot.loadError
                    ? html`
                          <div class="error">${inputs.bot.loadError}</div>
                      `
                    : nothing}
                <div class="actions">
                    <${ViraButton.assign({
                        text: 'Run now',
                        buttonSize: ViraSize.Small,
                        isDisabled:
                            state.isBusy ||
                            !!inputs.bot.loadError ||
                            inputs.bot.state === BotState.Running,
                    })}
                        ${listen('click', async () => {
                            if (
                                host.instanceInputs.bot.loadError ||
                                host.instanceInputs.bot.state === BotState.Running
                            ) {
                                return;
                            }
                            await act(async () => {
                                await botsClient.call('runNow', {
                                    botId: inputs.bot.botId,
                                });
                            });
                        })}
                    ></${ViraButton}>
                    <${ViraButton.assign({
                        text: 'Reload bot list',
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        isDisabled: state.isBusy,
                    })}
                        ${listen('click', async () => {
                            await act(async () => {
                                await botsClient.call('refresh', {});
                            });
                        })}
                    ></${ViraButton}>
                </div>
                ${state.error
                    ? html`
                          <div class="error">${state.error}</div>
                      `
                    : nothing}
                ${inputs.questions.map((question) => {
                    const typed = state.answers[question.questionId] || '';
                    return html`
                        <div class="question">
                            <div>${question.question}</div>
                            <div class="actions">
                                ${question.options.map((option) => {
                                    return html`
                                        <${ViraButton.assign({
                                            text: option,
                                            buttonSize: ViraSize.Small,
                                            isDisabled: state.isBusy,
                                        })}
                                            ${listen('click', async () => {
                                                await answer(question.questionId, option);
                                            })}
                                        ></${ViraButton}>
                                    `;
                                })}
                                ${question.isFreeTextAllowed
                                    ? html`
                                          <${ViraInput.assign({
                                              value: typed,
                                              placeholder: 'Your answer',
                                          })}
                                              ${listen(ViraInput.events.valueChange, (event) => {
                                                  updateState({
                                                      answers: {
                                                          ...host.instanceState.answers,
                                                          [question.questionId]: event.detail,
                                                      },
                                                  });
                                              })}
                                          ></${ViraInput}>
                                          <${ViraButton.assign({
                                              text: 'Send',
                                              buttonSize: ViraSize.Small,
                                              isDisabled: state.isBusy || !typed.trim(),
                                          })}
                                              ${listen('click', async () => {
                                                  const text = (
                                                      host.instanceState.answers[
                                                          question.questionId
                                                      ] || ''
                                                  ).trim();
                                                  if (!text) {
                                                      return;
                                                  }
                                                  await answer(question.questionId, text);
                                              })}
                                          ></${ViraButton}>
                                      `
                                    : nothing}
                                <${ViraButton.assign({
                                    text: 'Dismiss',
                                    buttonSize: ViraSize.Small,
                                    buttonEmphasis: ViraEmphasis.Subtle,
                                    isDisabled: state.isBusy,
                                })}
                                    ${listen('click', async () => {
                                        await answer(question.questionId, undefined);
                                    })}
                                ></${ViraButton}>
                            </div>
                        </div>
                    `;
                })}
                <h3>Settings</h3>
                ${state.fields
                    ? html`
                          <${ViraForm.assign({
                              fields: state.fields,
                          })}
                              ${listen(ViraForm.events.valueChange, (event) => {
                                  const fields = host.instanceState.fields;
                                  if (
                                      !fields ||
                                      !check.isEnumValue(event.detail.key, BotSettingsField)
                                  ) {
                                      return;
                                  }
                                  updateState({
                                      fields: {
                                          ...fields,
                                          [event.detail.key]: event.detail,
                                      },
                                  });
                              })}
                          ></${ViraForm}>
                      `
                    : nothing}
                <div class="actions">
                    <${ViraButton.assign({
                        text: 'Save settings',
                        buttonSize: ViraSize.Small,
                        isDisabled: state.isBusy,
                    })}
                        ${listen('click', async () => {
                            const fields = host.instanceState.fields;
                            if (!fields) {
                                return;
                            }
                            await act(async () => {
                                const {settings, apiKey} = readBotSettingsFields({
                                    fields,
                                    bot: host.instanceInputs.bot,
                                });
                                await botsClient.call('updateBotSettings', {
                                    botId: inputs.bot.botId,
                                    settings,
                                });
                                if (!apiKey) {
                                    return;
                                }
                                await botsClient.call('setApiKey', {
                                    botId: inputs.bot.botId,
                                    apiKey,
                                });
                                updateState({
                                    fields: {
                                        ...fields,
                                        [BotSettingsField.ApiKey]: createApiKeyField(true),
                                    },
                                });
                            });
                        })}
                    ></${ViraButton}>
                    ${inputs.bot.hasApiKey
                        ? html`
                              <${ViraButton.assign({
                                  text: 'Clear API key',
                                  buttonSize: ViraSize.Small,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  isDisabled: state.isBusy,
                              })}
                                  ${listen('click', async () => {
                                      await act(async () => {
                                          await botsClient.call('setApiKey', {
                                              botId: inputs.bot.botId,
                                              apiKey: undefined,
                                          });
                                      });
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
                </div>
                <h3>Runs</h3>
                <div class="runs">
                    ${state.runs.length
                        ? state.runs.map((run) => {
                              return html`
                                  <div class="run">
                                      <div class="header">
                                          ${renderTag(runStatusTags[run.status])}
                                          <span class="faint">
                                              ${runTriggerLabels[run.trigger]}
                                              <${ViraRelativeTime.assign({
                                                  time: createFullDateInUserTimezone(run.startedAt),
                                              })}></${ViraRelativeTime}>
                                          </span>
                                          ${run.aiThreadIds.map((threadId, index) => {
                                              return html`
                                                  <${ViraButton.assign({
                                                      text:
                                                          run.aiThreadIds.length > 1
                                                              ? `AI chat ${index + 1}`
                                                              : 'AI chat',
                                                      buttonSize: ViraSize.Small,
                                                      buttonEmphasis: ViraEmphasis.Subtle,
                                                  })}
                                                      ${listen('click', () => {
                                                          openThread(threadId);
                                                      })}
                                                  ></${ViraButton}>
                                              `;
                                          })}
                                      </div>
                                      ${run.error
                                          ? html`
                                                <div class="error">${run.error}</div>
                                            `
                                          : nothing}
                                      ${run.reports.length
                                          ? html`
                                                <ul>
                                                    ${run.reports.map((line) => {
                                                        return html`
                                                            <li>${line}</li>
                                                        `;
                                                    })}
                                                </ul>
                                            `
                                          : nothing}
                                      ${run.startedThreadIds.length
                                          ? html`
                                                <div class="faint">
                                                    Started ${run.startedThreadIds.length} sidebar
                                                    thread${run.startedThreadIds.length > 1
                                                        ? 's'
                                                        : ''}.
                                                </div>
                                            `
                                          : nothing}
                                  </div>
                              `;
                          })
                        : html`
                              <div class="faint">No runs yet.</div>
                          `}
                </div>
            </div>
            <div class="panes">
                ${state.shell
                    ? html`
                          <${VirPaneGroup.assign({
                              context: inputs.context,
                              folder: state.shell.folder,
                              scope: state.shell.scope,
                              active: inputs.isShown,
                              defaultTabs: [],
                          })}></${VirPaneGroup}>
                      `
                    : nothing}
            </div>
        `;
    },
});
