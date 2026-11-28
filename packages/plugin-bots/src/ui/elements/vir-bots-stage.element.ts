import {toPaneGroupKey} from '@agent-storm/common';
import {
    addTab,
    createTabId,
    defineAppElement,
    hasTabOfKind,
    listTabIds,
    VirPaneGroup,
    type ActivityRoute,
    type AppContext,
} from '@agent-storm/core/frontend';
import {css, html, repeat} from 'element-vir';
import {viraThemeByKeys} from 'vira';
import {botPaneId} from '../../bots-api.js';
import {botsMemory} from '../../util/bots-memory.js';
import {findSelectedBotsTarget, type BotsSnapshot} from '../../util/bots-state.js';

/** The Bots tab's content: the selected bot's or repo config's tabs. */
export const VirBotsStage = defineAppElement<{
    context: AppContext;
    snapshot: BotsSnapshot;
    /** Its route segments are a repo id or a bot id. */
    route: ActivityRoute;
    isShown: boolean;
}>()({
    tagName: 'vir-bots-stage',
    state() {
        return {
            /**
             * Pane groups whose saved layout has been given a Bot tab if it lacked one, so a Bot
             * tab the user closes stays closed until the window reloads.
             */
            checkedLayoutKeys: [] as ReadonlyArray<string>,
        };
    },
    styles: css`
        :host {
            display: block;
            position: absolute;
            inset: 0;
        }

        ${VirPaneGroup} {
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
    render({inputs, state, updateState, host}) {
        const target = findSelectedBotsTarget({
            repos: inputs.snapshot.state?.repos || [],
            selectedId: inputs.route.subPaths[0],
        });

        if (!target) {
            return html`
                <div class="empty">${inputs.snapshot.state ? 'Select a bot.' : 'Loading…'}</div>
            `;
        }

        const targetId = target.bot?.botId || target.repo.repoId;
        if (
            !inputs.context.isInActivityTab &&
            targetId !== botsMemory.selectedTarget.window.read()
        ) {
            inputs.context.uiLayout.rememberSelection({
                memory: botsMemory.selectedTarget,
                value: targetId,
            });
        }

        const layoutKey = toPaneGroupKey({
            folder: target.repo.repoPath,
            scope: target.scope,
        });

        /**
         * A pane group with no saved layout starts on its Bot tab, but one saved before the Bot tab
         * existed needs it added. Deferred via a microtask so we don't mutate during render.
         */
        if (!state.checkedLayoutKeys.includes(layoutKey)) {
            void Promise.resolve().then(() => {
                const uiLayout = host.instanceInputs.context.uiLayout;
                if (
                    !uiLayout.value.layout ||
                    host.instanceState.checkedLayoutKeys.includes(layoutKey)
                ) {
                    return;
                }
                updateState({
                    checkedLayoutKeys: [
                        ...host.instanceState.checkedLayoutKeys,
                        layoutKey,
                    ],
                });
                uiLayout.updateTabLayout({
                    folder: layoutKey,
                    update(layout) {
                        return layout &&
                            hasTabOfKind(layout, {
                                tabIds: listTabIds(layout),
                                kind: botPaneId,
                            })
                            ? layout
                            : layout &&
                                  addTab(layout, {
                                      tab: {
                                          id: createTabId(botPaneId),
                                          kind: botPaneId,
                                      },
                                      index: 0,
                                  });
                    },
                });
            });
        }

        /** Keyed since a pane group reads its folder and scope only when it's created. */
        return repeat(
            [
                target,
            ],
            () => layoutKey,
            ({repo, scope}) => {
                return html`
                    <${VirPaneGroup.assign({
                        context: inputs.context,
                        folder: repo.repoPath,
                        scope,
                        active: inputs.isShown,
                        isNewSessionKindInActiveGroup: true,
                        defaultTabs: [
                            [
                                {
                                    kind: botPaneId,
                                },
                            ],
                        ],
                    })}></${VirPaneGroup}>
                `;
            },
        );
    },
});
