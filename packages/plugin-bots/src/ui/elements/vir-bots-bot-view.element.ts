import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {assertWrap, check} from '@augment-vir/assert';
import {extractErrorMessage, omitObjectKeys} from '@augment-vir/common';
import {createFullDateInUserTimezone, toSimpleString} from 'date-vir';
import {css, html, listen, nothing} from 'element-vir';
import {
    ViraButton,
    ViraCheckbox,
    ViraCollapsibleCard,
    ViraEmphasis,
    ViraForm,
    ViraInput,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {
    BotRunStatus,
    BotState,
    type BotInfo,
    type BotQuestion,
    type BotRepo,
    type BotRun,
} from '../../bots-api.js';
import {addBotThreadTab} from '../../util/bot-tabs.js';
import {botsClient} from '../../util/bots-client.js';
import {createBusyAction} from '../../util/busy-action.js';
import {
    BotSettingsField,
    createApiKeyField,
    createBotSettingsFields,
    readBotSettingsFields,
    type BotSettingsFields,
} from './bot-settings-fields.js';
import {botStateTags, renderTag, runStatusTags} from './bots-display.js';
import {botViewStyles} from './bots-styles.js';
import {VirBotsTimeUntil} from './vir-bots-time-until.element.js';

/** A run with nothing to show beyond its status. Consecutive ones collapse into one row. */
function isQuietRun(run: Readonly<BotRun>) {
    return (
        run.status === BotRunStatus.NothingToDo &&
        !run.error &&
        !run.reports.length &&
        !run.startedThreadIds.length
    );
}

/** One bot's Bot tab: its controls, settings, questions, and run history. */
export const VirBotsBotView = defineAppElement<{
    context: AppContext;
    repo: Readonly<BotRepo>;
    bot: Readonly<BotInfo>;
    /** The bot's unanswered questions. */
    questions: ReadonlyArray<Readonly<BotQuestion>>;
}>()({
    tagName: 'vir-bots-bot-view',
    state() {
        return {
            /** The form as the user changed it, until it's saved. */
            editedFields: undefined as BotSettingsFields | undefined,
            runs: [] as ReadonlyArray<Readonly<BotRun>>,
            /** What the user typed as each question's answer, by question id. */
            answers: {} as Readonly<Record<string, string>>,
            error: undefined as string | undefined,
            isBusy: false,
            removeRunsListener: undefined as (() => void) | undefined,
        };
    },
    styles: css`
        :host {
            display: block;
        }

        ${botViewStyles}

        .view {
            max-width: 640px;
        }

        .title {
            display: flex;
            flex-direction: column;
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
            removeRunsListener: botsClient.listen('runsChanged', ({botId}) => {
                if (botId === host.instanceInputs.bot.botId) {
                    loadRuns();
                }
            }),
        });
        loadRuns();
        /** The shell tab joins the bot's tabs once its session exists. */
        botsClient
            .call('ensureBotShell', {
                botId: inputs.bot.botId,
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
        const act = createBusyAction({
            host,
            updateState,
        });

        /** The saved settings, unless the user changed them, with the API key's current state. */
        function readFields() {
            const fields =
                host.instanceState.editedFields || createBotSettingsFields(host.instanceInputs.bot);
            const typedKey = fields[BotSettingsField.ApiKey].value;
            return {
                ...fields,
                [BotSettingsField.ApiKey]: createApiKeyField({
                    hasApiKey: host.instanceInputs.bot.hasApiKey,
                    typed: check.isString(typedKey) ? typedKey : '',
                }),
            };
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

        return html`
            <div class="view">
                <div class="title">
                    <div class="header">
                        <h2>${inputs.bot.name}</h2>
                        <${ViraCheckbox.assign({
                            label: 'Enabled',
                            value: inputs.bot.settings.isEnabled,
                            useHorizontalLabel: true,
                            fillWhenChecked: true,
                            fillWhenUnchecked: true,
                            isDisabled: state.isBusy,
                        })}
                            ${listen(ViraCheckbox.events.valueChange, async (event) => {
                                await act(async () => {
                                    await botsClient.call('updateBotSettings', {
                                        botId: host.instanceInputs.bot.botId,
                                        settings: {
                                            ...host.instanceInputs.bot.settings,
                                            isEnabled: event.detail,
                                        },
                                        apiKey: undefined,
                                    });
                                });
                            })}
                        ></${ViraCheckbox}>
                        ${inputs.bot.state === BotState.Off
                            ? nothing
                            : renderTag(botStateTags[inputs.bot.state])}
                        ${inputs.bot.nextRunAt
                            ? html`
                                  <span class="faint">
                                      Next run in
                                      <${VirBotsTimeUntil.assign({
                                          time: inputs.bot.nextRunAt,
                                      })}></${VirBotsTimeUntil}>
                                  </span>
                              `
                            : nothing}
                    </div>
                    <span class="faint">${inputs.repo.name}</span>
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
                                host.instanceState.isBusy ||
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
                    ${inputs.bot.aiThreadId
                        ? html`
                              <${ViraButton.assign({
                                  text: 'AI chat',
                                  buttonSize: ViraSize.Small,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                              })}
                                  ${listen('click', () => {
                                      const threadId = host.instanceInputs.bot.aiThreadId;
                                      if (threadId) {
                                          addBotThreadTab({
                                              uiLayout: host.instanceInputs.context.uiLayout,
                                              repoPath: host.instanceInputs.repo.repoPath,
                                              botId: host.instanceInputs.bot.botId,
                                              threadId,
                                              isShown: true,
                                          });
                                      }
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
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
                <${ViraCollapsibleCard.assign({})}>
                    <h3 slot=${ViraCollapsibleCard.slotNames['vira-collapsible-card-header']}>
                        Settings
                    </h3>
                    <${ViraForm.assign({
                        fields: readFields(),
                    })}
                        ${listen(ViraForm.events.valueChange, (event) => {
                            if (!check.isEnumValue(event.detail.key, BotSettingsField)) {
                                return;
                            }
                            updateState({
                                editedFields: {
                                    ...readFields(),
                                    [event.detail.key]: event.detail,
                                },
                            });
                        })}
                    ></${ViraForm}>
                    <div class="actions">
                        <${ViraButton.assign({
                            text: 'Save settings',
                            buttonSize: ViraSize.Small,
                            isDisabled: state.isBusy,
                        })}
                            ${listen('click', async () => {
                                await act(async () => {
                                    const {settings, apiKey} = readBotSettingsFields({
                                        fields: readFields(),
                                        bot: host.instanceInputs.bot,
                                    });
                                    await botsClient.call('updateBotSettings', {
                                        botId: host.instanceInputs.bot.botId,
                                        settings,
                                        apiKey,
                                    });
                                    updateState({
                                        editedFields: undefined,
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
                </${ViraCollapsibleCard}>
                <h3>Runs</h3>
                <div class="runs">
                    ${state.runs.length
                        ? state.runs
                              .reduce(
                                  (groups: ReadonlyArray<ReadonlyArray<Readonly<BotRun>>>, run) => {
                                      const lastGroup = groups.at(-1);
                                      return lastGroup?.[0] &&
                                          isQuietRun(lastGroup[0]) &&
                                          isQuietRun(run)
                                          ? [
                                                ...groups.slice(0, -1),
                                                [
                                                    ...lastGroup,
                                                    run,
                                                ],
                                            ]
                                          : [
                                                ...groups,
                                                [
                                                    run,
                                                ],
                                            ];
                                  },
                                  [],
                              )
                              .map((group) => {
                                  const run = assertWrap.isDefined(group[0]);
                                  return html`
                                      <div class="run">
                                          <div class="header">
                                              ${renderTag(runStatusTags[run.status])}
                                              ${group.length > 1
                                                  ? html`
                                                        <span>×${group.length}</span>
                                                    `
                                                  : nothing}
                                              <span class="faint">
                                                  ${toSimpleString(
                                                      createFullDateInUserTimezone(run.startedAt),
                                                      {
                                                          includeSeconds: false,
                                                          includeTimezone: false,
                                                      },
                                                  )}
                                              </span>
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
                                                        Started ${run.startedThreadIds.length}
                                                        sidebar
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
        `;
    },
});
