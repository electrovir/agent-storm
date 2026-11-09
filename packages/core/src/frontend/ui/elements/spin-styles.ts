import {css} from 'element-vir';
import {viraAnimationDurations} from 'vira';

/**
 * Keyframes for {@link spinAnimationCss}. Goes at the top level of each element's styles: keyframes
 * don't cross shadow roots and can't be nested inside a rule.
 */
export const spinKeyframesCss = css`
    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
`;

/** Spins the matched element forever, at the speed of Vira's animated loader icon. */
export const spinAnimationCss = css`
    animation: ${viraAnimationDurations['vira-extended-animation-duration'].value} linear spin
        infinite;
`;
