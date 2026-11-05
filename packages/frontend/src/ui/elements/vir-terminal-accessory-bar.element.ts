// cspell:words decckm

import {colorCss} from '@electrovir/color';
import {css, defineElementEvent, html, listen} from 'element-vir';
import {createSizedIcon, LucideClipboardIcon, ViraIcon, viraThemeByKeys} from 'vira';
import {defineAppElement} from '../define-app-element.js';

/** One accessory key: a single sequence per tap, no sticky toggle. */
export type AccessoryKey = {
    label: string;
    title: string;
    bytes: string;
    /**
     * Sent in place of `bytes` while the terminal has application cursor keys (DECCKM) on, which
     * zsh's line editor turns on for the duration of every prompt. The two forms can be bound to
     * different widgets: `^[OA` is `up-line-or-beginning-search` (search history for what's already
     * typed) while `^[[A` is a plain `up-line-or-history` walk. Xterm picks the form itself for a
     * hardware key; these buttons write straight to the pty, so they have to pick it too.
     */
    applicationBytes?: string | undefined;
};

/**
 * The bytes are the exact escape sequences xterm would send for the corresponding physical key, so
 * the pty / TUI can't tell the difference between these and a hardware keyboard.
 */
const accessoryKeys: ReadonlyArray<Readonly<AccessoryKey>> = [
    {
        label: 'esc',
        title: 'Escape',
        bytes: '\x1b',
    },
    {
        label: '←',
        title: 'Left arrow',
        bytes: '\x1b[D',
        applicationBytes: '\x1bOD',
    },
    {
        label: '↑',
        title: 'Up arrow',
        bytes: '\x1b[A',
        applicationBytes: '\x1bOA',
    },
    {
        label: '↓',
        title: 'Down arrow',
        bytes: '\x1b[B',
        applicationBytes: '\x1bOB',
    },
    {
        label: '→',
        title: 'Right arrow',
        bytes: '\x1b[C',
        applicationBytes: '\x1bOC',
    },
    {
        label: 'tab',
        title: 'Tab',
        bytes: '\t',
    },
];

const clipboardIcon = createSizedIcon(LucideClipboardIcon, 18);

/**
 * Touch key bar (paste / Ctrl / Esc / arrows / Tab) for terminals on devices without a hardware
 * keyboard. Every button acts on `pointerdown` and cancels it, so a tap never steals focus from
 * xterm's hidden textarea and the soft keyboard stays up.
 */
export const VirTerminalAccessoryBar = defineAppElement<{
    ctrlArmed: boolean;
}>()({
    tagName: 'vir-terminal-accessory-bar',
    events: {
        /**
         * The parent picks `bytes` or `applicationBytes`, since only it can read the terminal's
         * live cursor-key mode at the moment of the tap.
         */
        keyPress: defineElementEvent<Readonly<AccessoryKey>>(),
        ctrlToggle: defineElementEvent<void>(),
        pasteRequest: defineElementEvent<void>(),
    },
    /*
     * In normal flow as the last flex-column child so it can't overlap the terminal. vir-app
     * already shrinks the whole app to the keyboard-free area (its --app-viewport-height tracks
     * window.visualViewport), so this just sits at the bottom of the visible pane — above the
     * keyboard — with no positioning math of its own. Colors come from the Vira theme so the bar
     * follows the app's light/dark selection.
     */
    styles: css`
        :host {
            flex-grow: 0;
            flex-shrink: 0;
            display: flex;
            gap: 6px;
            padding: 6px;
            box-sizing: border-box;
            background: ${viraThemeByKeys.grey['behind-bg'].body.background.value};
            border-top: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            /* Sit inside the iPhone home-indicator safe area when the keyboard is closed. */
            padding-bottom: max(6px, env(safe-area-inset-bottom));
        }

        .accessory-key {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-grow: 1;
            flex-shrink: 1;
            min-width: 0;
            min-height: 40px;
            padding: 0 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            border-radius: 6px;
            font-size: 16px;
            color: ${viraThemeByKeys.grey.foreground.body.foreground.value};
            background: ${viraThemeByKeys.grey['behind-fg']['small-body'].background.value};
            cursor: pointer;
            touch-action: manipulation;
            user-select: none;

            &:active {
                background: ${viraThemeByKeys.grey['behind-bg'].body.background.value};
            }

            &[data-armed] {
                ${colorCss(viraThemeByKeys.blue.foreground.body)};
                border-color: ${viraThemeByKeys.blue.foreground.body.background.value};
            }
        }
    `,
    init({host}) {
        host.setAttribute('role', 'toolbar');
        host.setAttribute('aria-label', 'Terminal keys');
    },
    render({inputs, dispatch, events}) {
        const keysTemplate = accessoryKeys.map((key) => {
            return html`
                <button
                    type="button"
                    class="accessory-key"
                    title=${key.title}
                    ${listen('pointerdown', (event) => {
                        event.preventDefault();
                        dispatch(
                            new events.keyPress({
                                detail: key,
                            }),
                        );
                    })}
                >
                    ${key.label}
                </button>
            `;
        });

        return html`
            <button
                type="button"
                class="accessory-key"
                title="Paste from clipboard"
                ${listen('pointerdown', (event) => {
                    event.preventDefault();
                    dispatch(
                        new events.pasteRequest({
                            detail: undefined,
                        }),
                    );
                })}
            >
                <${ViraIcon.assign({
                    icon: clipboardIcon,
                })}></${ViraIcon}>
            </button>
            <button
                type="button"
                class="accessory-key ctrl-key"
                title="Ctrl — applies to the next key you press"
                ?data-armed=${inputs.ctrlArmed}
                ${listen('pointerdown', (event) => {
                    event.preventDefault();
                    dispatch(
                        new events.ctrlToggle({
                            detail: undefined,
                        }),
                    );
                })}
            >
                ctrl
            </button>
            ${keysTemplate}
        `;
    },
});
