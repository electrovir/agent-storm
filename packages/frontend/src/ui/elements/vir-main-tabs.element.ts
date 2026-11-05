import {css, html, listen} from 'element-vir';
import {noUserSelect, viraThemeByKeys} from 'vira';
import {type AppContext} from '../../util/app-context.js';
import {getShownPrQueues, PrQueueKind} from '../../util/frontend-state.js';
import {
    bareMainTabPaths,
    MainTab,
    mainTabLabels,
    orderedMainTabs,
    router,
} from '../../util/router.js';
import {defineAppElement} from '../define-app-element.js';

/**
 * The app's outermost navigation. Vertical by default: a narrow strip pinned to the left of the
 * sidebar, with labels rotated to read bottom-to-top so it can stay thin. `isHorizontal` lays the
 * same tabs out as a normal row of upright labels, which is what fits above the sidebar inside the
 * mobile modal.
 */
export const VirMainTabs = defineAppElement<{
    context: AppContext;
    isHorizontal?: boolean | undefined;
}>()({
    tagName: 'vir-main-tabs',
    styles: css`
        :host {
            display: flex;
            flex-shrink: 0;
            font-size: 12px;
        }

        .tabs {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            border-right: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};

            &[data-horizontal] {
                flex-direction: row;
                border-right: none;
                border-bottom: 1px solid
                    ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            }
        }

        .tab {
            ${noUserSelect};
            appearance: none;
            background: transparent;
            border: none;
            border-right: 2px solid transparent;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 14px 8px;
            cursor: pointer;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
            font: inherit;
            letter-spacing: 0.02em;
            transition:
                color 120ms ease,
                border-color 120ms ease;

            &:hover {
                color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            }

            &[data-selected] {
                color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
                border-right-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }
        }

        /* The selected marker moves to the edge the strip now borders on. */
        [data-horizontal] .tab {
            border-right: none;
            border-bottom: 2px solid transparent;
            flex-grow: 1;
            padding: 12px 8px;

            &[data-selected] {
                border-bottom-color: ${viraThemeByKeys.blue.foreground.body.foreground.value};
            }
        }

        /*
         * vertical-rl alone lays Latin text out reading top-to-bottom (glyph tops facing right);
         * the 180deg flip turns it into bottom-to-top with glyph tops facing left, which is the
         * orientation you read by tilting your head to the left. Using writing-mode rather than a
         * bare rotate(-90deg) keeps the label's layout box tall-and-narrow, so the strip's width is
         * driven by the font size instead of the text length.
         */
        .label {
            writing-mode: vertical-rl;
            transform: rotate(180deg);
            white-space: nowrap;
        }

        [data-horizontal] .label {
            writing-mode: horizontal-tb;
            transform: none;
        }
    `,
    render({inputs}) {
        const frontendState = inputs.context.frontendState?.value;
        /** PRs waiting on review, shown after the Review label once the queue first loads. */
        const reviewCount =
            frontendState &&
            getShownPrQueues(frontendState)[PrQueueKind.Review].queue?.pullRequests.length;
        const isTabShown: Record<MainTab, boolean> = {
            [MainTab.Dashboard]: true,
            [MainTab.Build]: true,
            [MainTab.Review]: true,
            [MainTab.Debug]: inputs.context.isDebugTabShown,
        };
        const labels: Record<MainTab, string> = {
            ...mainTabLabels,
            [MainTab.Review]:
                reviewCount == undefined
                    ? mainTabLabels[MainTab.Review]
                    : `${mainTabLabels[MainTab.Review]} (${reviewCount})`,
        };

        return html`
            <div class="tabs" role="tablist" ?data-horizontal=${inputs.isHorizontal}>
                ${orderedMainTabs
                    .filter((tab) => isTabShown[tab])
                    .map((tab) => {
                        const isActive = tab === inputs.context.resolved.mainTab;
                        return html`
                            <button
                                type="button"
                                class="tab"
                                role="tab"
                                ?data-selected=${isActive}
                                aria-selected=${isActive}
                                ${listen('click', () => {
                                    router.setRoute(
                                        inputs.context.resolved.restoredRouteByMainTab[tab] ?? {
                                            paths: bareMainTabPaths[tab],
                                            search: undefined,
                                        },
                                    );
                                })}
                            >
                                <span class="label">${labels[tab]}</span>
                            </button>
                        `;
                    })}
            </div>
        `;
    },
});
