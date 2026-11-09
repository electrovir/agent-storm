import {listenToDarkMode} from '@agent-storm/core/frontend';
import {type ITheme} from '@xterm/xterm';

/**
 * Xterm paints its cells from this palette in JS — it renders to a canvas and can't see the Vira
 * theme's CSS variables — so the light/dark selection has to be handed to it explicitly and
 * re-handed whenever the user changes it. {@link listenToDarkMode} is what delivers the change.
 *
 * The light palette is extracted from Terminal.app's `vir-light` profile via the bundled
 * `extract-terminal-theme.swift` helper. Slots that the plist omits (because they match
 * Terminal.app's built-in defaults) are filled in here so xterm renders the full 16-color palette.
 * The dark palette is its counterpart: the same hues pulled up to stay legible on a dark surface.
 */
export const terminalThemes: Readonly<Record<'light' | 'dark', ITheme>> = {
    light: {
        background: '#ffffff',
        foreground: '#0220b3',
        cursor: '#ff2600',
        cursorAccent: '#ffffff',
        /**
         * Xterm pre-blends `selectionBackground` against the terminal-level background once at
         * theme load and paints the result as an opaque rectangle over the cells; it does not
         * invert or alpha-composite per cell at draw time (that's an xterm renderer limitation).
         */
        selectionBackground: 'rgba(56, 213, 255, 0.18)',
        black: '#000000',
        red: '#990000',
        green: '#009400',
        yellow: '#737300',
        blue: '#0038ee',
        magenta: '#b300b3',
        cyan: '#007f89',
        white: '#818181',
        brightBlack: '#666666',
        brightRed: '#ff0004',
        brightGreen: '#00bb0f',
        brightYellow: '#a5a500',
        brightBlue: '#0064ff',
        brightMagenta: '#e500e5',
        brightCyan: '#2799bb',
        brightWhite: '#bababa',
    },
    dark: {
        background: '#16181d',
        foreground: '#d5dbe6',
        cursor: '#ff5c4d',
        cursorAccent: '#16181d',
        selectionBackground: 'rgba(96, 178, 255, 0.30)',
        black: '#21252b',
        red: '#e06c75',
        green: '#98c379',
        yellow: '#d3ba6a',
        blue: '#61afef',
        magenta: '#c678dd',
        cyan: '#56b6c2',
        white: '#abb2bf',
        brightBlack: '#5c6370',
        brightRed: '#ff7b86',
        brightGreen: '#b5e890',
        brightYellow: '#ffd88a',
        brightBlue: '#82caff',
        brightMagenta: '#e2a2f5',
        brightCyan: '#7fd4dd',
        brightWhite: '#ffffff',
    },
};

export function terminalTheme(isDark: boolean): ITheme {
    return isDark ? terminalThemes.dark : terminalThemes.light;
}

/** Six hex digits, the only form the `/pty` socket carries a color in. */
const bareHexRegExp = /^[\da-f]{6}$/i;

/**
 * Drops the `#` the palette above writes, since a `#` in a search param would start a URL fragment.
 * A color with no six-digit hex form (a shorthand, an `rgba()`) becomes empty, which the host reads
 * as "leave the matching query unanswered".
 */
function toBareHex(color: string | undefined) {
    const bare = (color || '').replace(/^#/, '');
    return bareHexRegExp.test(bare) ? bare.toLowerCase() : '';
}

/**
 * The palette in the form the host forwards to the daemon, which answers the pty's OSC 10 / 11
 * color queries with it — see `answerColorQueries` in `pty-pool.ts` for why answering them here
 * (where xterm could) is too slow for codex.
 */
export function terminalColors(isDark: boolean) {
    const theme = terminalTheme(isDark);
    return {
        foreground: toBareHex(theme.foreground),
        background: toBareHex(theme.background),
    };
}
