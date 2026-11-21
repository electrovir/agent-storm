import {defineAppElement} from '@agent-storm/core/frontend';
import {assertWrap} from '@augment-vir/assert';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {popover, PopoverManager, renderMenuItemEntries, ViraMenu} from 'vira';
import {canDiscardSide} from '../../util/diff-status.js';
import {type HunkMenu} from './diff-pane-requests.js';
import {stageScopeLabel} from './diff-selection.js';
import {createPointPopoverStyles} from './point-popover-styles.js';
import {stageActionLabels} from './vir-diff-file-header.element.js';

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
    state() {
        return {
            popoverManager: new PopoverManager(),
        };
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

        ${createPointPopoverStyles(css`.menu-popover`)}

        ${ViraMenu} {
            min-width: 160px;
        }
    `,
    render({inputs, state, dispatch, events, host}) {
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
            <span
                class="point-anchor"
                style=${css`
                    left: ${inputs.menu.x}px;
                    top: ${inputs.menu.y}px;
                `}
                ${popover(state.popoverManager, {
                    trigger: true,
                    getPopover() {
                        return assertWrap.instanceOf(
                            host.shadowRoot.querySelector('.menu-popover'),
                            HTMLElement,
                        );
                    },
                })}
            ></span>
            <div class="menu-popover" popover="manual">
                <${ViraMenu}>
                    ${renderMenuItemEntries([
                        {
                            content: `${stageActionLabels[inputs.menu.target.side]} ${scopeText}`,
                            hideIcon: true,
                            onClick() {
                                dispatch(
                                    new events.stage({
                                        detail: inputs.menu,
                                    }),
                                );
                            },
                        },
                        {
                            content: `Undo ${scopeText}`,
                            hideIcon: true,
                            hidden: !canDiscardSide[inputs.menu.target.side],
                            onClick() {
                                dispatch(
                                    new events.undo({
                                        detail: inputs.menu,
                                    }),
                                );
                            },
                        },
                    ])}
                </${ViraMenu}>
            </div>
        `;
    },
});
