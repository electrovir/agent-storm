/**
 * Coarse screen-size buckets the rest of the frontend can branch on. Modeled after
 * `@flax-ai/common-frontend`'s `screen-size.ts` but trimmed to two buckets — `Desktop` and
 * `Mobile` — since agent-storm doesn't currently have a tablet-specific layout.
 *
 * Wired into `vir-app`'s state via {@link determineScreenSize} + an `attachOnResize` observer.
 * Nothing reads it yet; the plumbing is here so future responsive UI work can flip on
 * `frontendState.screenSize === ScreenSize.Mobile` instead of writing yet another media query.
 */
export enum ScreenSize {
    Desktop = 'desktop',
    Mobile = 'mobile',
}

/**
 * Element widths strictly less than the given number trigger that screen size. `Desktop` is the
 * fallback (Infinity); `Mobile` triggers under 1000 CSS pixels — chosen to roughly match the
 * smallest comfortable horizontal layout for the sidebar + a single pane group.
 */
export const screenSizeWidthMax: Readonly<Record<ScreenSize, number>> = {
    [ScreenSize.Desktop]: Infinity,
    [ScreenSize.Mobile]: 1000,
};

/**
 * Hysteresis around the threshold so the active screen size doesn't flap when the viewport sits
 * exactly at the boundary. Once a size is active, we keep it until the width moves more than
 * `stickyThresholdPx` past the boundary in the other direction.
 */
const stickyThresholdPx = 30;

function widthMatchesSize(width: number, size: ScreenSize, thresholdPx: number): boolean {
    /**
     * Inclusive on the floor, exclusive on the ceiling: a width exactly equal to a smaller size's
     * max counts as the *larger* size. With only two sizes this collapses to "below max → Mobile;
     * otherwise → Desktop", with the threshold widening the range of the currently-active size.
     */
    const max = screenSizeWidthMax[size];
    const min = size === ScreenSize.Mobile ? 0 : screenSizeWidthMax[ScreenSize.Mobile];
    return width >= min - thresholdPx && width < max + thresholdPx;
}

/**
 * Pick the {@link ScreenSize} for the given element width. If `currentScreenSize` is provided and
 * the width is still within the sticky-threshold band of that size, keep it. Otherwise pick the
 * size whose range actually contains the width (without the threshold, so the boundary is crisp).
 */
export function determineScreenSize({
    currentScreenSize,
    elementWidth,
}: Readonly<{
    currentScreenSize: ScreenSize | undefined;
    elementWidth: number;
}>): ScreenSize {
    const width = Math.abs(elementWidth);
    if (
        currentScreenSize &&
        widthMatchesSize(width, currentScreenSize, stickyThresholdPx)
    ) {
        return currentScreenSize;
    }
    return widthMatchesSize(width, ScreenSize.Mobile, 0)
        ? ScreenSize.Mobile
        : ScreenSize.Desktop;
}
