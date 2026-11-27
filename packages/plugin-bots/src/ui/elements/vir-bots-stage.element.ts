import {defineAppElement, type AppContext} from '@agent-storm/core/frontend';
import {css, html, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {type BotsSnapshot} from '../../util/bots-state.js';
import {VirBotsBotView} from './vir-bots-bot-view.element.js';
import {VirBotsRepoView} from './vir-bots-repo-view.element.js';

/** The Bots tab's content: the selected repo's config or the selected bot. */
export const VirBotsStage = defineAppElement<{
    context: AppContext;
    snapshot: BotsSnapshot;
    /** The Bots activity's route segments: a repo id or a bot id. */
    subPaths: ReadonlyArray<string>;
    isShown: boolean;
}>()({
    tagName: 'vir-bots-stage',
    styles: css`
        :host {
            display: block;
            position: absolute;
            inset: 0;
        }

        .empty {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
            font-size: 13px;
        }
    `,
    render({inputs}) {
        const selectedId = inputs.subPaths[0];
        const repos = inputs.snapshot.state?.repos || [];
        const selectedRepo = repos.find((repo) => repo.repoId === selectedId);
        const selectedBot = repos
            .flatMap((repo) => {
                return repo.bots.map((bot) => {
                    return {
                        repo,
                        bot,
                    };
                });
            })
            .find(({bot}) => bot.botId === selectedId);

        if (selectedRepo) {
            return repeat(
                [
                    selectedRepo,
                ],
                (repo) => repo.repoId,
                (repo) => {
                    return html`
                        <${VirBotsRepoView.assign({
                            repo,
                        })}></${VirBotsRepoView}>
                    `;
                },
            );
        } else if (selectedBot) {
            /** Keyed so each bot's view loads its own runs and shell. */
            return repeat(
                [
                    selectedBot,
                ],
                ({bot}) => bot.botId,
                ({repo, bot}) => {
                    return html`
                        <${VirBotsBotView.assign({
                            context: inputs.context,
                            repo,
                            bot,
                            questions:
                                inputs.snapshot.state?.questions.filter((question) => {
                                    return question.botId === bot.botId;
                                }) || [],
                            isShown: inputs.isShown,
                        })}></${VirBotsBotView}>
                    `;
                },
            );
        } else {
            return html`
                <div class="empty">${inputs.snapshot.state ? 'Select a bot.' : 'Loading…'}</div>
            `;
        }
    },
});
