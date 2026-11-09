/**
 * The editor's own surface, unchanged code included. Light comes from the Vir Colors VS Code theme
 * (`editor.background`, `editor.foreground`) plus VS Code's built-in light default for line
 * numbers, which that theme leaves unset. Dark defers to the app around it, since a `transparent`
 * background and an inherited foreground track whatever the surrounding theme is doing.
 */
const editorColors: Readonly<
    Record<
        'light' | 'dark',
        Readonly<{
            background: string;
            foreground: string;
            lineNumber: string;
        }>
    >
> = {
    light: {
        background: '#fafafa',
        foreground: '#383a42',
        lineNumber: '#237893',
    },
    dark: {
        background: 'transparent',
        foreground: 'inherit',
        lineNumber: '#858585',
    },
};

export function editorSurfaceColors(isDark: boolean) {
    return isDark ? editorColors.dark : editorColors.light;
}
