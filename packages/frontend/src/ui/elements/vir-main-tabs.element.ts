import {css, defineElement, defineElementEvent, html, listen} from 'element-vir';
import {noUserSelect, viraThemeByKeys} from 'vira';
import {reportRenderError} from '../../util/client-error-log.js';
import {mainTabLabels, orderedMainTabs, type MainTab} from '../../util/router.js';

/**
 * The app's outermost navigation. Vertical by default: a narrow strip pinned to the left of the
 * sidebar, with labels rotated to read bottom-to-top so it can stay thin. `isHorizontal` lays the
 * same tabs out as a normal row of upright labels, which is what fits above the sidebar inside the
 * mobile modal.
 */
export const VirMainTabs = defineElement<{
    activeTab: MainTab;
    isHorizontal?: boolean | undefined;
}>()({
    tagName: 'vir-main-tabs',
    options: {
        errorHandler: reportRenderError,
    },
    events: {
        tabRequested: defineElementEvent<MainTab>(),
    },
    styles: css`
        :host {
            display: flex;
            font-family: ui-sans-serif, system-ui, sans-serif;
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
    render({inputs, dispatch, events}) {
        return html`
            <div class="tabs" ?data-horizontal=${inputs.isHorizontal}>
                ${orderedMainTabs.map((tab) => {
                    const isActive = tab === inputs.activeTab;
                    return html`
                        <button
                            type="button"
                            class="tab"
                            role="tab"
                            ?data-selected=${isActive}
                            aria-selected=${isActive}
                            ${listen('click', () => {
                                dispatch(new events.tabRequested(tab));
                            })}
                        >
                            <span class="label">${mainTabLabels[tab]}</span>
                        </button>
                    `;
                })}
            </div>
        `;
    },
});
