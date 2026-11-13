import {getObjectTypedValues} from '@augment-vir/common';
import {css, html} from 'element-vir';
import {viraThemeByKeys, ViraThemeColorName} from 'vira';

const projectIconColors = getObjectTypedValues(ViraThemeColorName);

function deriveMonogram(projectName: string) {
    const words =
        projectName
            .normalize('NFKC')
            .trim()
            .match(/[\p{L}\p{N}]+/gu) || [];
    const firstWord = words[0];
    if (!firstWord) {
        return 'PR';
    }
    const glyphs = Array.from(firstWord);
    const first = glyphs[0] || 'P';
    const second =
        glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ||
        (words.length > 1 ? Array.from(words.at(-1) || '')[0] : glyphs.at(-1)) ||
        first;
    return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join('');
}

function deriveColor(projectName: string) {
    const seed = projectName.normalize('NFKC').trim().toLocaleLowerCase('en-US') || 'project';
    const index = Array.from(seed).reduce((accumulator, glyph) => {
        return (accumulator * 31 + (glyph.codePointAt(0) || 0)) % projectIconColors.length;
    }, 0);
    return projectIconColors[index] || ViraThemeColorName.blue;
}

/** A project without an icon gets a two-letter tile tinted by a color derived from its name. */
export function renderProjectMonogram({
    projectName,
    size = 16,
}: Readonly<{projectName: string; size?: number}>) {
    const monogram = deriveMonogram(projectName);
    return html`
        <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            style=${css`
                flex-shrink: 0;
                width: ${size}px;
                height: ${size}px;
                overflow: hidden;
                border-radius: 25%;
                user-select: none;
                font-family: monospace;
                color: ${viraThemeByKeys[deriveColor(projectName)].foreground.header.foreground
                    .value};
                background-color: color-mix(in srgb, currentColor 14%, transparent);
            `}
        >
            <text
                x="8"
                y="10.8"
                text-anchor="middle"
                fill="currentColor"
                font-size="8.25"
                font-weight="700"
                textLength=${Array.from(monogram).length === 1 ? 6 : 12}
                lengthAdjust="spacingAndGlyphs"
                text-rendering="geometricPrecision"
            >
                ${monogram}
            </text>
        </svg>
    `;
}
