import {css, type CSSResult} from 'element-vir';
import {createAnchoredPopoverStyles} from 'vira';

/**
 * Styles for a `popover` opened from a `.point-anchor` placed at a pointer position. The popover
 * opens below and to the right of the point and flips to whichever side has room.
 */
export function createPointPopoverStyles(selector: CSSResult) {
    const leftwardsStyles = css`
        position-area: block-end span-inline-start;
    `;

    return css`
        .point-anchor {
            position: fixed;
            width: 0;
            height: 0;
        }

        ${createAnchoredPopoverStyles({
            selector,
            fallbacks: [
                {
                    name: 'point-popover-leftwards',
                    styles: leftwardsStyles,
                },
                {
                    name: 'point-popover-upwards',
                    styles: css``,
                    flipBlock: true,
                },
                {
                    name: 'point-popover-upwards-leftwards',
                    styles: leftwardsStyles,
                    flipBlock: true,
                },
            ],
        })}

        ${selector} {
            position-area: block-end span-inline-end;
        }
    `;
}
