import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {ViraButton, ViraEmphasis, ViraSize} from 'vira';
import {BotConfigApproval, botsPluginId, type BotRepo} from '../../bots-api.js';
import {botsClient} from '../../util/bots-client.js';
import {createBusyAction} from '../../util/busy-action.js';
import {approvalTags, renderTag} from './bots-display.js';
import {botViewStyles} from './bots-styles.js';

/**
 * A repo's `.agent-storm/agent-storm.config` file, for the user to read before allowing its bots to
 * run.
 */
export const VirBotsRepoView = defineAppElement<{
    context: AppContext;
    repo: Readonly<BotRepo>;
}>()({
    tagName: 'vir-bots-repo-view',
    state() {
        return {
            config: undefined as Readonly<{contents: string; hash: string}> | undefined,
            error: undefined as string | undefined,
            isBusy: false,
        };
    },
    styles: css`
        :host {
            display: block;
        }

        ${botViewStyles}
    `,
    init({inputs, updateState}) {
        botsClient
            .call('readConfigFile', {
                repoPath: inputs.repo.repoPath,
            })
            .then((config) => {
                updateState({
                    config,
                });
            })
            .catch((error: unknown) => {
                updateState({
                    error: extractErrorMessage(error),
                });
            });
    },
    render({inputs, state, updateState, host}) {
        const act = createBusyAction({
            host,
            updateState,
        });

        const isApproved = inputs.repo.approval === BotConfigApproval.Approved;

        return html`
            <div class="view">
                <div class="header">
                    <h2>${inputs.repo.name}</h2>
                    ${renderTag(approvalTags[inputs.repo.approval])}
                </div>
                <div class="faint">${inputs.repo.configPath}</div>
                <div>
                    ${inputs.repo.approval === BotConfigApproval.Changed
                        ? 'This file changed since you approved it. '
                        : nothing}
                    Approving lets Agent Storm run this file, everything it imports, and the bots it
                    lists, with your access, on each bot's schedule once you turn the bot on. Only
                    this file shows here, so read the bot files it names too. Editing this file or a
                    bot file it names by path asks again. Edits to what those files import, or to
                    installed dependencies, don't. For a TS or JS config, only its own text is
                    checked.
                </div>
                ${state.error
                    ? html`
                          <div class="error">${state.error}</div>
                      `
                    : nothing}
                ${isApproved && inputs.repo.listError
                    ? html`
                          <div class="error">${inputs.repo.listError}</div>
                      `
                    : nothing}
                ${isApproved && !inputs.repo.listError
                    ? inputs.repo.bots.length
                        ? html`
                              <div class="actions">
                                  ${inputs.repo.bots.map((bot) => {
                                      return html`
                                          <${ViraButton.assign({
                                              text: bot.name,
                                              buttonSize: ViraSize.Small,
                                              buttonEmphasis: ViraEmphasis.Subtle,
                                          })}
                                              ${listen('click', () => {
                                                  host.instanceInputs.context.navigate([
                                                      botsPluginId,
                                                      bot.botId,
                                                  ]);
                                              })}
                                          ></${ViraButton}>
                                      `;
                                  })}
                              </div>
                          `
                        : html`
                              <div class="faint">The config lists no bots.</div>
                          `
                    : nothing}
                <div class="actions">
                    ${state.config && !isApproved
                        ? html`
                              <${ViraButton.assign({
                                  text: 'Approve',
                                  buttonSize: ViraSize.Small,
                                  isDisabled: state.isBusy,
                              })}
                                  ${listen('click', async () => {
                                      const config = host.instanceState.config;
                                      if (host.instanceState.isBusy || !config) {
                                          return;
                                      }
                                      await act(async () => {
                                          await botsClient.call('approveConfig', {
                                              repoPath: host.instanceInputs.repo.repoPath,
                                              hash: config.hash,
                                          });
                                      });
                                  })}
                              ></${ViraButton}>
                          `
                        : nothing}
                    <${ViraButton.assign({
                        text: 'Refresh',
                        buttonSize: ViraSize.Small,
                        buttonEmphasis: ViraEmphasis.Subtle,
                        isDisabled: state.isBusy,
                    })}
                        ${listen('click', async () => {
                            await act(async () => {
                                const [config] = await Promise.all([
                                    botsClient.call('readConfigFile', {
                                        repoPath: host.instanceInputs.repo.repoPath,
                                    }),
                                    botsClient.call('refresh', {}),
                                ]);
                                updateState({
                                    config,
                                });
                            });
                        })}
                    ></${ViraButton}>
                </div>
                ${state.config
                    ? html`
                          <pre>${state.config.contents}</pre>
                      `
                    : state.error
                      ? nothing
                      : html`
                            <div class="faint">Loading…</div>
                        `}
            </div>
        `;
    },
});
