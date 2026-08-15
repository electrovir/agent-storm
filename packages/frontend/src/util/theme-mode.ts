import {defaultApplyThemeCallback, type ApplyThemeCallback} from 'vira';

/**
 * Whether the app is currently rendering its dark theme, broadcast to the parts of the UI that CSS
 * variables can't reach.
 *
 * Vira's theme client swaps a set of CSS variables, so anything styled through `viraTheme` recolors
 * on its own. A terminal doesn't: xterm paints glyphs into a canvas from a color palette handed to
 * it in JS, and it has no way to observe a variable change. Those consumers subscribe here
 * instead.
 */
const darkModeState: {
    isDark: boolean;
    listeners: Set<(isDark: boolean) => void>;
} = {
    isDark: false,
    listeners: new Set(),
};

export function isDarkMode(): boolean {
    return darkModeState.isDark;
}

/** Returns an unsubscribe callback. Call it on element cleanup. */
export function listenToDarkMode(listener: (isDark: boolean) => void): () => void {
    darkModeState.listeners.add(listener);
    return () => {
        darkModeState.listeners.delete(listener);
    };
}

/**
 * Applies Vira's own theme swap and then fans the resulting mode out to subscribers. Pass this to
 * `ViraThemeClient` as its `applyTheme` so a single client drives both.
 */
export const applyThemeMode: ApplyThemeCallback = ({useDarkTheme}) => {
    void defaultApplyThemeCallback({
        useDarkTheme,
    });
    if (darkModeState.isDark === useDarkTheme) {
        return;
    }
    darkModeState.isDark = useDarkTheme;
    darkModeState.listeners.forEach((listener) => listener(useDarkTheme));
};
