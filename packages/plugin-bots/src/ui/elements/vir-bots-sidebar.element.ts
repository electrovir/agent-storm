import {defineAppElement, type ActivityRoute} from '@agent-storm/core/frontend';
import {createFullDateInUserTimezone} from 'date-vir';
import {css, html, listen, nothing} from 'element-vir';
import {ViraRelativeTime, viraThemeByKeys} from 'vira';
import {BotConfigApproval, BotState} from '../../bots-api.js';
import {type BotsSnapshot} from '../../util/bots-state.js';
import {approvalTags, botStateTags, renderTag} from './bots-display.js';

/** The Bots tab's sidebar: each repo with an `agent-storm.config` file, and its bots. */
export const VirBotsSidebar = defineAppElement<{
    snapshot: BotsSnapshot;
    route: ActivityRoute;
}>()({
    tagName: 'vir-bots-sidebar',
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 12px;
            padding: 8px 0;
            font-size: 13px;
        }

        .note {
            padding: 0 12px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        .error {
            padding: 0 12px;
            color: ${viraThemeByKeys.red.foreground.body.foreground.value};
            overflow-wrap: anywhere;
        }

        .repo {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .repo-name {
            padding: 0 12px;
            font-weight: bold;
        }

        .row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 12px 4px 20px;
            cursor: pointer;
            user-select: none;

            &:hover {
                background-color: ${viraThemeByKeys.grey['behind-fg']['small-body'].background
                    .value};
            }

            &[data-active] {
                background-color: ${viraThemeByKeys.blue['behind-fg']['small-body'].background
                    .value};
            }
        }

        .row-name {
            flex-grow: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .next-run {
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 12px;
        }
    `,
    render({inputs}) {
        const state = inputs.snapshot.state;
        const selectedId = inputs.route.subPaths[0];
        if (!state) {
            return inputs.snapshot.loadError
                ? html`
                      <div class="error">${inputs.snapshot.loadError}</div>
                  `
                : html`
                      <div class="note">Loading…</div>
                  `;
        } else if (state.repos.length) {
            return state.repos.map((repo) => {
                return html`
                    <div class="repo">
                        <div class="repo-name">${repo.name}</div>
                        ${repo.approval === BotConfigApproval.Approved
                            ? nothing
                            : html`
                                  <div
                                      class="row"
                                      ?data-active=${selectedId === repo.repoId}
                                      ${listen('click', () => {
                                          inputs.route.navigate([
                                              repo.repoId,
                                          ]);
                                      })}
                                  >
                                      <span class="row-name">Review agent-storm.config</span>
                                      ${renderTag(approvalTags[repo.approval])}
                                  </div>
                              `}
                        ${repo.listError
                            ? html`
                                  <div class="error">${repo.listError}</div>
                              `
                            : nothing}
                        ${repo.bots.map((bot) => {
                            return html`
                                <div
                                    class="row"
                                    ?data-active=${selectedId === bot.botId}
                                    ${listen('click', () => {
                                        inputs.route.navigate([
                                            bot.botId,
                                        ]);
                                    })}
                                >
                                    <span class="row-name">${bot.name}</span>
                                    ${bot.nextRunAt
                                        ? html`
                                              <span class="next-run">
                                                  <${ViraRelativeTime.assign({
                                                      time: createFullDateInUserTimezone(
                                                          bot.nextRunAt,
                                                      ),
                                                  })}></${ViraRelativeTime}>
                                              </span>
                                          `
                                        : nothing}
                                    ${renderTag(
                                        bot.loadError
                                            ? botStateTags[BotState.Failed]
                                            : botStateTags[bot.state],
                                    )}
                                </div>
                            `;
                        })}
                    </div>
                `;
            });
        } else {
            return html`
                <div class="note">No repo in the sidebar has an agent-storm.config file.</div>
            `;
        }
    },
});
