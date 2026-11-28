import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {css, html, repeat, type Observable} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {findBotsTargetByScope, type BotsSnapshot} from '../../util/bots-state.js';
import {VirBotsBotView} from './vir-bots-bot-view.element.js';
import {VirBotsRepoView} from './vir-bots-repo-view.element.js';

/** A Bot tab's content: its pane group's bot, or the repo config waiting on approval. */
export const VirBotsPane = defineAppElement<{
    context: AppContext;
    /** The pane group's scope. */
    scope: string | undefined;
    snapshot: Observable<BotsSnapshot>;
}>()({
    tagName: 'vir-bots-pane',
    styles: css`
        :host {
            flex-grow: 1;
            flex-basis: 0;
            min-width: 0;
            min-height: 0;
            overflow-y: auto;
            display: block;
        }

        .empty {
            padding: 12px 16px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 13px;
        }
    `,
    render({inputs}) {
        const state = inputs.snapshot.value.state;
        const target = findBotsTargetByScope({
            repos: state?.repos || [],
            scope: inputs.scope,
        });

        if (!state || !target) {
            return html`
                <div class="empty">${state ? 'This bot is no longer listed.' : 'Loading…'}</div>
            `;
        }

        /** Keyed so each bot's view loads its own runs and shell. */
        return repeat(
            [
                target,
            ],
            ({scope}) => scope,
            ({repo, bot}) => {
                return bot
                    ? html`
                          <${VirBotsBotView.assign({
                              context: inputs.context,
                              repo,
                              bot,
                              questions: state.questions.filter((question) => {
                                  return question.botId === bot.botId;
                              }),
                          })}></${VirBotsBotView}>
                      `
                    : html`
                          <${VirBotsRepoView.assign({
                              context: inputs.context,
                              repo,
                          })}></${VirBotsRepoView}>
                      `;
            },
        );
    },
});
