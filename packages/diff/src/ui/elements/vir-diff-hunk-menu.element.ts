import {defineAppElement} from '@agent-storm/core/frontend';
import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen, nothing} from 'element-vir';
import {viraShadows, viraThemeByKeys} from 'vira';
import {canDiscardSide} from '../../util/diff-status.js';
import {type HunkMenu} from './diff-pane-requests.js';
import {stageScopeLabel} from './diff-selection.js';
import {stageActionLabels} from './vir-diff-review-file.element.js';

/**
 * The diff pane's right-click menu for the chunks under a selection, with a full-screen backdrop
 * that closes it on the next click anywhere. Each choice closes the menu and hands its `menu`
 * back.
 */
export const VirDiffHunkMenu = defineAppElement<{
    menu: HunkMenu;
}>()({
    tagName: 'vir-diff-hunk-menu',
    events: {
        stage: defineElementEvent<HunkMenu>(),
        undo: defineElementEvent<HunkMenu>(),
        close: defineElementEvent<undefined>(),
    },
    styles: css`
        /*
         * Catches the click that dismisses the menu, wherever it lands. Fixed so a click outside
         * the pane closes the menu too.
         */
        .menu-backdrop {
            position: fixed;
            inset: 0;
            z-index: 3;
        }

        /*
         * Positioned in viewport coordinates from the pointer that opened it, which is why it is
         * fixed: the pane scrolls and the editor is a scroll container of its own, so anchoring to
         * either would need the offsets recomputed on every scroll.
         */
        .hunk-menu {
            position: fixed;
            z-index: 4;
            display: flex;
            flex-direction: column;
            min-width: 160px;
            padding: 3px;
            border-radius: 5px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            ${viraShadows.menuShadow}
            ${colorCss(viraThemeByKeys.grey['behind-fg'].body)};
        }

        .hunk-menu button {
            appearance: none;
            border: none;
            background: none;
            padding: 5px 8px;
            border-radius: 3px;
            text-align: left;
            cursor: pointer;
            font: inherit;
            color: inherit;
        }

        .hunk-menu button:hover {
            ${colorCss(viraThemeByKeys.blue.foreground.body)};
        }
    `,
    render({inputs, dispatch, events}) {
        const scopeText = stageScopeLabel(inputs.menu.selections).text;

        function close() {
            dispatch(
                new events.close({
                    detail: undefined,
                }),
            );
        }

        return html`
            <div
                class="menu-backdrop"
                ${listen('pointerdown', close)}
                ${listen('contextmenu', (event) => {
                    event.preventDefault();
                    close();
                })}
            ></div>
            <div
                class="hunk-menu"
                style=${css`
                    left: ${inputs.menu.x}px;
                    top: ${inputs.menu.y}px;
                `}
            >
                <button
                    type="button"
                    ${listen('click', () => {
                        dispatch(
                            new events.stage({
                                detail: inputs.menu,
                            }),
                        );
                    })}
                >
                    ${stageActionLabels[inputs.menu.target.side]} ${scopeText}
                </button>
                ${canDiscardSide[inputs.menu.target.side]
                    ? html`
                          <button
                              type="button"
                              ${listen('click', () => {
                                  dispatch(
                                      new events.undo({
                                          detail: inputs.menu,
                                      }),
                                  );
                              })}
                          >
                              Undo ${scopeText}
                          </button>
                      `
                    : nothing}
            </div>
        `;
    },
});
