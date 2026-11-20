import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {fittedImageView, panImageView, zoomImageView} from './image-zoom.js';

const bounds = {
    imageSize: {
        width: 100,
        height: 100,
    },
    viewportSize: {
        width: 200,
        height: 200,
    },
};

describe(zoomImageView.name, () => {
    it('keeps the point under the anchor in place', () => {
        assert.deepEquals(
            zoomImageView({
                ...bounds,
                view: fittedImageView,
                zoom: 4,
                anchor: {
                    x: 20,
                    y: 0,
                },
            }),
            {
                zoom: 4,
                x: -60,
                y: 0,
            },
        );
    });
    it('centers the image again when zooming below its fitted size', () => {
        assert.deepEquals(
            zoomImageView({
                ...bounds,
                view: {
                    zoom: 4,
                    x: -60,
                    y: 30,
                },
                zoom: 0.5,
                anchor: {
                    x: 50,
                    y: 50,
                },
            }),
            fittedImageView,
        );
    });
});

describe(panImageView.name, () => {
    it('stops at the image edge', () => {
        assert.deepEquals(
            panImageView({
                ...bounds,
                view: {
                    zoom: 4,
                    x: 0,
                    y: 0,
                },
                delta: {
                    x: 500,
                    y: -30,
                },
            }),
            {
                zoom: 4,
                x: 100,
                y: -30,
            },
        );
    });
});
