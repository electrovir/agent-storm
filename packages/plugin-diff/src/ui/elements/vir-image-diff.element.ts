import {defineAppElement} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {css, html, listen, nothing} from 'element-vir';
import {ViraDropdown, ViraSlider, viraThemeByKeys} from 'vira';
import {type GitDiffFileContents} from '../../diff-api.js';
import {diffMemory, ImageDiffMode} from '../../util/diff-memory.js';

const imageDiffModeLabels: Readonly<Record<ImageDiffMode, string>> = {
    [ImageDiffMode.TwoUp]: '2-up',
    [ImageDiffMode.Swipe]: 'Swipe',
    [ImageDiffMode.OnionSkin]: 'Onion skin',
};

/** The overlay modes stack one image on the other, so they need both. */
const needsBothImages: Readonly<Record<ImageDiffMode, boolean>> = {
    [ImageDiffMode.TwoUp]: false,
    [ImageDiffMode.Swipe]: true,
    [ImageDiffMode.OnionSkin]: true,
};

/**
 * An image file shown as pictures rather than as a text diff, in GitHub's three image diff modes:
 * 2-up, swipe, and onion skin. The chosen mode is remembered for every image.
 *
 * In 2-up the new version comes first and the previous one sits under it: the new image is what the
 * user came to look at, and scrolling down to the old one is a cheaper comparison than two
 * half-width columns.
 *
 * A side with no image still gets its frame, saying why: an added image has no before and a deleted
 * one has no after, and a missing frame is indistinguishable from a pane that failed to show it.
 */
export const VirImageDiff = defineAppElement<{
    content: Readonly<GitDiffFileContents>;
}>()({
    tagName: 'vir-image-diff',
    state() {
        return {
            mode: diffMemory.imageDiffMode.read(),
            /** Percent of the after image shown, for both overlay modes. */
            position: 50,
        };
    },
    styles: css`
        :host {
            display: flex;
            flex-direction: column;
            flex-grow: 1;
            min-width: 0;
            min-height: 0;
        }

        .image-diff {
            display: flex;
            flex-direction: column;
            gap: 12px;
            flex-grow: 1;
            min-width: 0;
            padding: 12px;
            box-sizing: border-box;
            overflow: auto;
        }

        .mode-bar {
            display: flex;
            justify-content: center;
        }

        /*
         * Sized to its own image rather than to a share of the pane: stacked, two grown sides split
         * the height between them and shrink both images for no reason, since the column scrolls.
         */
        .image-side {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 6px;
            flex-grow: 0;
            flex-shrink: 0;
            min-width: 0;
        }

        .image-side-label {
            font-size: 10px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }

        /*
         * Checkerboard, the way every image editor draws it: a transparent PNG is otherwise
         * indistinguishable from a white or black one, which is exactly the change most worth
         * seeing in an icon diff.
         */
        .image-frame {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            padding: 8px;
            box-sizing: border-box;
            border-radius: 4px;
            border: 1px solid ${viraThemeByKeys.grey['behind-bg'].decoration.background.value};
            background-image: linear-gradient(
                    45deg,
                    rgba(128, 128, 128, 0.22) 25%,
                    transparent 25%,
                    transparent 75%,
                    rgba(128, 128, 128, 0.22) 75%
                ),
                linear-gradient(
                    45deg,
                    rgba(128, 128, 128, 0.22) 25%,
                    transparent 25%,
                    transparent 75%,
                    rgba(128, 128, 128, 0.22) 75%
                );
            background-size: 16px 16px;
            background-position:
                0 0,
                8px 8px;
        }

        /* Nothing to see through, so the checkerboard would only read as a second empty image. */
        .image-frame[data-empty] {
            background-image: none;
        }

        /*
         * Every layer shares one grid cell, so the cell is as big as the larger image and both
         * images center in the same box.
         */
        .overlay-stack {
            display: grid;
            flex-shrink: 0;
        }

        .layer {
            grid-area: 1 / 1;
            display: flex;
            align-items: center;
            justify-content: center;
            min-width: 0;
        }

        .swipe-line-layer {
            grid-area: 1 / 1;
            position: relative;
            pointer-events: none;
        }

        .swipe-line {
            position: absolute;
            top: 0;
            bottom: 0;
            width: 2px;
            transform: translateX(-1px);
            background-color: ${viraThemeByKeys.blue.foreground['non-body'].foreground.value};
        }

        .slider-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;

            & ${ViraSlider} {
                flex-grow: 1;
            }
        }

        .image-empty-note {
            padding: 8px;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
        }

        /*
         * Scaled down to fit but never up: a 16px favicon blown across the pane says nothing about
         * what changed in it.
         */
        img {
            max-width: 100%;
            max-height: 60vh;
            object-fit: contain;
        }

        .image-diff-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-grow: 1;
            padding: 24px;
            text-align: center;
            font-size: 11px;
            color: ${viraThemeByKeys.grey.foreground['non-body'].foreground.value};
        }
    `,
    render({inputs, state, updateState}) {
        const {oldImage, newImage} = inputs.content;
        if (!check.isString(oldImage) && !check.isString(newImage)) {
            return html`
                <div class="image-diff-empty">Empty image on both sides.</div>
            `;
        }
        const hasBothImages = !!oldImage && !!newImage;
        const mode =
            hasBothImages || !needsBothImages[state.mode] ? state.mode : ImageDiffMode.TwoUp;

        const modeBarTemplate = html`
            <div class="mode-bar">
                <${ViraDropdown.assign({
                    options: getEnumValues(ImageDiffMode).map((option) => {
                        return {
                            value: option,
                            label: imageDiffModeLabels[option],
                            disabled: needsBothImages[option] && !hasBothImages,
                        };
                    }),
                    selected: [
                        mode,
                    ],
                })}
                    ${listen(ViraDropdown.events.selectedValuesChange, (event) => {
                        const chosen = event.detail[0];
                        if (check.isEnumValue(chosen, ImageDiffMode)) {
                            diffMemory.imageDiffMode.write(chosen);
                            updateState({
                                mode: chosen,
                            });
                        }
                    })}
                ></${ViraDropdown}>
            </div>
        `;

        if (mode === ImageDiffMode.TwoUp || !oldImage || !newImage) {
            const sides = [
                {
                    label: 'After',
                    image: newImage,
                    emptyNote: 'Deleted — no current version.',
                },
                {
                    label: 'Before',
                    image: oldImage,
                    emptyNote: 'New file — no previous version.',
                },
            ];
            return html`
                <div class="image-diff">
                    ${modeBarTemplate}
                    ${sides.map((side) => {
                        return html`
                            <div class="image-side">
                                <span class="image-side-label">${side.label}</span>
                                <div class="image-frame" ?data-empty=${!side.image}>
                                    ${side.image
                                        ? html`
                                              <img src=${side.image} alt=${side.label} />
                                          `
                                        : html`
                                              <span class="image-empty-note">
                                                  ${side.emptyNote}
                                              </span>
                                          `}
                                </div>
                            </div>
                        `;
                    })}
                </div>
            `;
        }

        const afterLayerStyles: Readonly<Record<ImageDiffMode, ReturnType<typeof css>>> = {
            [ImageDiffMode.TwoUp]: css``,
            /** The after image covers the stack from the left edge up to the swipe line. */
            [ImageDiffMode.Swipe]: css`
                clip-path: inset(0 ${100 - state.position}% 0 0);
            `,
            [ImageDiffMode.OnionSkin]: css`
                opacity: ${state.position / 100};
            `,
        };

        return html`
            <div class="image-diff">
                ${modeBarTemplate}
                <div class="image-frame overlay-stack">
                    <div class="layer">
                        <img src=${oldImage} alt="Before" />
                    </div>
                    <div class="layer" style=${afterLayerStyles[mode]}>
                        <img src=${newImage} alt="After" />
                    </div>
                    ${mode === ImageDiffMode.Swipe
                        ? html`
                              <div class="swipe-line-layer">
                                  <div
                                      class="swipe-line"
                                      style=${css`
                                          left: ${state.position}%;
                                      `}
                                  ></div>
                              </div>
                          `
                        : nothing}
                </div>
                <div class="slider-row">
                    <span class="image-side-label">Before</span>
                    <${ViraSlider.assign({
                        value: state.position,
                        label: `${imageDiffModeLabels[mode]} position`,
                    })}
                        ${listen(ViraSlider.events.valueChange, (event) => {
                            updateState({
                                position: event.detail,
                            });
                        })}
                    ></${ViraSlider}>
                    <span class="image-side-label">After</span>
                </div>
            </div>
        `;
    },
});
