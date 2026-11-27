import {clamp} from '@augment-vir/common';

/** How far an image is scaled past its fitted size and panned from its viewport's center. */
export type ImageView = {
    /** 1 for the fitted size. */
    zoom: number;
    /** Pixels the image's center sits right of the viewport's center. */
    x: number;
    /** Pixels the image's center sits below the viewport's center. */
    y: number;
};

export type Point = {
    x: number;
    y: number;
};

export type Size = {
    width: number;
    height: number;
};

/** The image's size at zoom 1 and the size of the viewport showing it. */
export type ImageViewBounds = {
    imageSize: Readonly<Size>;
    viewportSize: Readonly<Size>;
};

export const fittedImageView: Readonly<ImageView> = {
    zoom: 1,
    x: 0,
    y: 0,
};

const maxImageZoom = 8;

/**
 * Keeps an image larger than the viewport from leaving a gap at an edge, and a smaller one from
 * sliding past an edge.
 */
function clampImageView({
    view,
    imageSize,
    viewportSize,
}: Readonly<ImageViewBounds> & {
    view: Readonly<ImageView>;
}) {
    const maxX = Math.abs(imageSize.width * view.zoom - viewportSize.width) / 2;
    const maxY = Math.abs(imageSize.height * view.zoom - viewportSize.height) / 2;

    return {
        zoom: view.zoom,
        x: clamp(view.x, {
            min: -maxX,
            max: maxX,
        }),
        y: clamp(view.y, {
            min: -maxY,
            max: maxY,
        }),
    };
}

/** Moves the image by `delta` pixels, within the limits of `clampImageView`. */
export function panImageView({
    view,
    delta,
    ...bounds
}: Readonly<ImageViewBounds> & {
    view: Readonly<ImageView>;
    delta: Readonly<Point>;
}) {
    return clampImageView({
        ...bounds,
        view: {
            zoom: view.zoom,
            x: view.x + delta.x,
            y: view.y + delta.y,
        },
    });
}

/**
 * Zooms to `zoom`, kept between the fitted size and the max zoom, holding the image point under
 * `anchor` in place.
 */
export function zoomImageView({
    view,
    zoom,
    anchor,
    ...bounds
}: Readonly<ImageViewBounds> & {
    view: Readonly<ImageView>;
    zoom: number;
    /** Relative to the viewport's center. */
    anchor: Readonly<Point>;
}) {
    const nextZoom = clamp(zoom, {
        min: 1,
        max: maxImageZoom,
    });
    const ratio = nextZoom / view.zoom;

    return clampImageView({
        ...bounds,
        view: {
            zoom: nextZoom,
            x: anchor.x - (anchor.x - view.x) * ratio,
            y: anchor.y - (anchor.y - view.y) * ratio,
        },
    });
}
