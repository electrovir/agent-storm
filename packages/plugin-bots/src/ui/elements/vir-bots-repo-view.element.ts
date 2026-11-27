import {defineAppElement} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {ViraButton, ViraEmphasis, ViraSize} from 'vira';
import {BotConfigApproval, type BotRepo} from '../../bots-api.js';
import {botsClient} from '../../util/bots-client.js';
import {approvalTags, renderTag} from './bots-display.js';
import {botViewStyles} from './bots-styles.js';

/** A repo's `agent-storm.config` file, for the user to read before allowing its bots to run. */
export const VirBotsRepoView = defineAppElement<{
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
            height: 100%;
            overflow-y: auto;
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
    render({inputs, state, updateState}) {
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
                    this file's own text is checked for changes, so edits to the bot files it
                    imports or to installed dependencies don't ask again.
                </div>
                ${state.error
                    ? html`
                          <div class="error">${state.error}</div>
                      `
                    : nothing}
                ${state.config
                    ? html`
                          <pre>${state.config.contents}</pre>
                          <div class="actions">
                              <${ViraButton.assign({
                                  text: 'Approve',
                                  buttonSize: ViraSize.Small,
                                  isDisabled: state.isBusy,
                              })}
                                  ${listen('click', async () => {
                                      if (state.isBusy || !state.config) {
                                          return;
                                      }
                                      updateState({
                                          isBusy: true,
                                          error: undefined,
                                      });
                                      try {
                                          await botsClient.call('approveConfig', {
                                              repoPath: inputs.repo.repoPath,
                                              hash: state.config.hash,
                                          });
                                      } catch (error) {
                                          updateState({
                                              error: extractErrorMessage(error),
                                          });
                                      } finally {
                                          updateState({
                                              isBusy: false,
                                          });
                                      }
                                  })}
                              ></${ViraButton}>
                              <${ViraButton.assign({
                                  text: 'Refresh',
                                  buttonSize: ViraSize.Small,
                                  buttonEmphasis: ViraEmphasis.Subtle,
                                  isDisabled: state.isBusy,
                              })}
                                  ${listen('click', async () => {
                                      if (state.isBusy) {
                                          return;
                                      }
                                      try {
                                          updateState({
                                              config: await botsClient.call('readConfigFile', {
                                                  repoPath: inputs.repo.repoPath,
                                              }),
                                              error: undefined,
                                          });
                                      } catch (error) {
                                          updateState({
                                              error: extractErrorMessage(error),
                                          });
                                      }
                                  })}
                              ></${ViraButton}>
                          </div>
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
