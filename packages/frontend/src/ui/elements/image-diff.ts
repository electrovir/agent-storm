import {type GitDiffFileContents} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {css, html} from 'element-vir';
import {viraThemeByKeys} from 'vira';

/**
 * An image file shown as pictures rather than as a text diff. The new version comes first and the
 * previous one sits under it, in both layouts: the new image is what the user came to look at, and
 * scrolling down to the old one is a cheaper comparison than two half-width columns.
 *
 * A side with no image still gets its frame, saying why: an added image has no before and a deleted
 * one has no after, and a missing frame is indistinguishable from a pane that failed to show it.
 */
export function renderImageDiff({content}: Readonly<{content: Readonly<GitDiffFileContents>}>) {
    const sides = [
        {
            label: 'After',
            image: content.newImage,
            emptyNote: 'Deleted — no current version.',
        },
        {
            label: 'Before',
            image: content.oldImage,
            emptyNote: 'New file — no previous version.',
        },
    ];
    if (!sides.some((side) => check.isString(side.image))) {
        return html`
            <div class="image-diff-empty">Empty image on both sides.</div>
        `;
    }
    return html`
        <div class="image-diff">
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
                                      <span class="image-empty-note">${side.emptyNote}</span>
                                  `}
                        </div>
                    </div>
                `;
            })}
        </div>
    `;
}

/** Styles for {@link renderImageDiff}, interpolated into each element that renders it. */
export const imageDiffStyles = css`
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

    .image-empty-note {
        padding: 8px;
        font-size: 11px;
        color: ${viraThemeByKeys.grey.foreground.placeholder.foreground.value};
    }

    /*
     * Scaled down to fit but never up: a 16px favicon blown across the pane says nothing about
     * what changed in it.
     */
    .image-frame img {
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
`;
