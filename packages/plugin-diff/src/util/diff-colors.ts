/**
 * CodeMirror's stock merge colors are a few percent of tint and wash out entirely on a bright
 * screen. The line and text colors below are the Diff V2 pane's instead (`@pierre/diffs` with its
 * default `pierre-light` and `pierre-dark` themes), so a diff reads the same in either pane.
 *
 * Two layers: every changed line gets a pale tint so the extent of the change is visible at a
 * glance, and the words the diff narrowed the edit down to sit on top in a darker shade.
 *
 * All values are opaque on purpose. A translucent tint composites once per element that carries it,
 * and CodeMirror nests a changed-text span inside a changed line inside (in the unified view) a
 * deleted chunk — so an alpha that looked right in isolation stacked two or three deep and came out
 * far darker than intended. Opaque colors render as written no matter how they nest, which is why
 * `@pierre/diffs`'s translucent text tints are pre-composited here over its line tint and theme
 * background rather than copied verbatim.
 *
 * `removedChunk` is the backdrop of a deleted block in the unified view, which `@pierre/diffs` has
 * no equivalent for.
 */
export type DiffColors = {
    removedLine: string;
    removedText: string;
    removedChunk: string;
    addedLine: string;
    addedText: string;
};

export const diffColors: Readonly<Record<'light' | 'dark', Readonly<DiffColors>>> = {
    light: {
        removedLine: '#ffe8e4',
        removedText: '#f9ccca',
        removedChunk: '#fafafa',
        addedLine: '#e7f4ec',
        addedText: '#c8e7d8',
    },
    dark: {
        removedLine: '#381917',
        removedText: '#5f1d1f',
        removedChunk: '#201517',
        addedLine: '#182d22',
        addedText: '#144b35',
    },
};

export function colorsFor(isDark: boolean): Readonly<DiffColors> {
    return isDark ? diffColors.dark : diffColors.light;
}
