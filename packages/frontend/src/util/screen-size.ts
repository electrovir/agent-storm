export enum ScreenSize {
    Desktop = 'desktop',
    Mobile = 'mobile',
}

export const screenSizeWidthMax: Readonly<Record<ScreenSize, number>> = {
    [ScreenSize.Desktop]: Infinity,
    [ScreenSize.Mobile]: 1000,
};

const stickyThresholdPx = 30;

function widthMatchesSize({
    width,
    size,
    thresholdPx,
}: Readonly<{
    width: number;
    size: ScreenSize;
    thresholdPx: number;
}>) {
    /**
     * Inclusive on the floor, exclusive on the ceiling: a width exactly equal to a smaller size's
     * max counts as the _larger_ size. With only two sizes this collapses to "below max → Mobile;
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
        widthMatchesSize({
            width,
            size: currentScreenSize,
            thresholdPx: stickyThresholdPx,
        })
    ) {
        return currentScreenSize;
    }
    return widthMatchesSize({
        width,
        size: ScreenSize.Mobile,
        thresholdPx: 0,
    })
        ? ScreenSize.Mobile
        : ScreenSize.Desktop;
}
