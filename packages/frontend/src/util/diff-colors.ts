/**
 * CodeMirror's stock merge colors are a few percent of tint and wash out entirely on a bright
 * screen. The light set below is VS Code's diff editor instead, so a diff read here looks like the
 * same diff read there.
 *
 * Two layers, as in VS Code: every changed line gets a pale tint so the extent of the change is
 * visible at a glance, and the words the diff narrowed the edit down to sit on top in a darker
 * shade.
 *
 * All values are opaque on purpose. A translucent tint composites once per element that carries it,
 * and CodeMirror nests a changed-text span inside a changed line inside (in the unified view) a
 * deleted chunk — so an alpha that looked right in isolation stacked two or three deep and came out
 * far darker than intended. Opaque colors render as written no matter how they nest, which is why
 * VS Code's translucent defaults are pre-composited here rather than copied verbatim:
 *
 * - `addedLine` — `diffEditor.insertedLineBackground` `rgba(155, 185, 85, 0.2)` over the editor
 *   background.
 * - `addedText` — `diffEditor.insertedTextBackground` `#9ccc2c40` over `addedLine`.
 * - `removedLine` — `diffEditor.removedLineBackground` `rgba(255, 0, 0, 0.2)` over the editor
 *   background.
 * - `removedText` — `diffEditor.removedTextBackground` `#ff000033` over `removedLine`.
 * - `removedChunk` — the editor background: VS Code's inline diff gives a deleted block no backdrop
 *   of its own beyond the per-line tint.
 *
 * Composited on a wide-gamut display rather than in sRGB, because that is where VS Code's own blend
 * happens and the two disagree: the same `rgba(255, 0, 0, 0.2)` lands visibly pinker when its alpha
 * is resolved in sRGB. The values below were calibrated against screenshots of VS Code and of this
 * pane taken on the same screen, so a red is a couple of percent less saturated than the arithmetic
 * alone would give.
 */
export type DiffColors = {
    removedLine: string;
    removedText: string;
    removedChunk: string;
    addedLine: string;
    addedText: string;
};

/**
 * The dark set is the light set's job done from the other end: dark enough that the code on top
 * keeps its contrast, tinted enough to find by scanning. The pale tints that work on white read as
 * glowing panels over a dark editor, which is why they aren't simply reused at a lower opacity. It
 * has no VS Code counterpart to copy — that install runs a light theme only.
 */
export const diffColors: Readonly<Record<'light' | 'dark', Readonly<DiffColors>>> = {
    light: {
        removedLine: '#f9d8d3',
        removedText: '#f7bab2',
        removedChunk: '#fafafa',
        addedLine: '#e8edde',
        addedText: '#d8e4ba',
    },
    dark: {
        removedLine: '#2b1a1d',
        removedText: '#452227',
        removedChunk: '#201517',
        addedLine: '#16271b',
        addedText: '#1f3d27',
    },
};

export function colorsFor(isDark: boolean): Readonly<DiffColors> {
    return isDark ? diffColors.dark : diffColors.light;
}
