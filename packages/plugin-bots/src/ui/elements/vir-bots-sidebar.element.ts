import {
    defineAppElement,
    sidebarTooltipOptions,
    VirSidebarSearch,
    type ActivityRoute,
} from '@agent-storm/core/frontend';
import {extractErrorMessage} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {
    LucideRotateCwIcon,
    tooltip,
    ViraButton,
    ViraColorVariant,
    ViraEmphasis,
    ViraSize,
    viraThemeByKeys,
} from 'vira';
import {BotConfigApproval, BotState} from '../../bots-api.js';
import {botsClient} from '../../util/bots-client.js';
import {findSelectedBotsTarget, type BotsSnapshot} from '../../util/bots-state.js';
import {approvalTags, botStateTags, listErrorTag, renderTag} from './bots-display.js';
import {VirBotsTimeUntil} from './vir-bots-time-until.element.js';

/** The Bots tab's sidebar: each repo with bots in its `.agent-storm/agent-storm.config` file. */
export const VirBotsSidebar = defineAppElement<{
    snapshot: BotsSnapshot;
    route: ActivityRoute;
}>()({
    tagName: 'vir-bots-sidebar',
    state() {
        return {
            searchQuery: '',
            isRefreshing: false,
            refreshError: undefined as string | undefined,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            height: 100%;
            font-size: 13px;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 6px;
            padding: 8px 5px;
            border-bottom: 1px solid
                ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
        }

        .list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            flex-grow: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 8px 0;
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
    render({inputs, state, updateState}) {
        const repos = inputs.snapshot.state?.repos || [];
        const target = findSelectedBotsTarget({
            repos,
            selectedId: inputs.route.subPaths[0],
        });
        const activeId = target?.bot?.botId || target?.repo.repoId;
        const query = state.searchQuery.trim().toLowerCase();

        function isMatch(...texts: ReadonlyArray<string>) {
            return !query || texts.some((text) => text.toLowerCase().includes(query));
        }

        const shownRepos = repos
            .map((repo) => {
                const configRowName =
                    repo.approval === BotConfigApproval.Approved
                        ? 'agent-storm.config'
                        : 'Review agent-storm.config';
                return {
                    repo,
                    configRowName,
                    hasConfigRow:
                        (repo.approval !== BotConfigApproval.Approved || !!repo.listError) &&
                        isMatch(repo.name, configRowName),
                    bots: repo.bots.filter((bot) => isMatch(repo.name, bot.name)),
                };
            })
            .filter(({hasConfigRow, bots}) => hasConfigRow || bots.length);
        const firstResultId = shownRepos.flatMap(({repo, hasConfigRow, bots}) => {
            return [
                ...(hasConfigRow
                    ? [
                          repo.repoId,
                      ]
                    : []),
                ...bots.map((bot) => bot.botId),
            ];
        })[0];

        function renderList() {
            if (!inputs.snapshot.state) {
                return inputs.snapshot.loadError
                    ? html`
                          <div class="error">${inputs.snapshot.loadError}</div>
                      `
                    : html`
                          <div class="note">Loading…</div>
                      `;
            } else if (!repos.length) {
                return html`
                    <div class="note">
                        No repo in the sidebar lists bots in a .agent-storm/agent-storm.config file.
                    </div>
                `;
            } else if (shownRepos.length) {
                return shownRepos.map(({repo, configRowName, hasConfigRow, bots}) => {
                    return html`
                        <div class="repo">
                            <div class="repo-name">${repo.name}</div>
                            ${hasConfigRow
                                ? html`
                                      <div
                                          class="row"
                                          data-sidebar-search-result
                                          ?data-active=${activeId === repo.repoId}
                                          ${listen('click', () => {
                                              inputs.route.navigate([
                                                  repo.repoId,
                                              ]);
                                          })}
                                      >
                                          <span class="row-name">${configRowName}</span>
                                          ${renderTag(
                                              repo.listError
                                                  ? listErrorTag
                                                  : approvalTags[repo.approval],
                                          )}
                                      </div>
                                  `
                                : nothing}
                            ${bots.map((bot) => {
                                return html`
                                    <div
                                        class="row"
                                        data-sidebar-search-result
                                        ?data-active=${activeId === bot.botId}
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
                                                      <${VirBotsTimeUntil.assign({
                                                          time: bot.nextRunAt,
                                                      })}></${VirBotsTimeUntil}>
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
                    <div class="note">No matching bots.</div>
                `;
            }
        }

        return html`
            <div
                class="header"
                ${listen(VirSidebarSearch.events.searchQueryChange, (event) => {
                    updateState({
                        searchQuery: event.detail,
                    });
                })}
                ${listen(VirSidebarSearch.events.searchSubmit, () => {
                    if (firstResultId) {
                        inputs.route.navigate([
                            firstResultId,
                        ]);
                    }
                })}
            >
                <${VirSidebarSearch.assign({
                    query: state.searchQuery,
                    hasResult: !!firstResultId,
                })}></${VirSidebarSearch}>
                <${ViraButton.assign({
                    icon: LucideRotateCwIcon,
                    buttonSize: ViraSize.Small,
                    buttonEmphasis: ViraEmphasis.Subtle,
                    color: ViraColorVariant.Neutral,
                    isDisabled: state.isRefreshing,
                })}
                    ${tooltip('Reload the bot list.', sidebarTooltipOptions)}
                    ${listen('click', async () => {
                        if (state.isRefreshing) {
                            return;
                        }
                        updateState({
                            isRefreshing: true,
                            refreshError: undefined,
                        });
                        try {
                            await botsClient.call('refresh', {});
                            updateState({
                                isRefreshing: false,
                            });
                        } catch (error) {
                            updateState({
                                isRefreshing: false,
                                refreshError: extractErrorMessage(error),
                            });
                        }
                    })}
                ></${ViraButton}>
            </div>
            <div class="list">
                ${state.refreshError
                    ? html`
                          <div class="error">${state.refreshError}</div>
                      `
                    : nothing}
                ${renderList()}
            </div>
        `;
    },
});
