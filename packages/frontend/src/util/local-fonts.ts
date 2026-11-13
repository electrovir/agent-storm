import {check} from '@augment-vir/assert';
import {removeDuplicates} from '@augment-vir/common';
import {assertValidShape, defineShape} from 'object-shape-tester';

const localFontsShape = defineShape([
    {
        family: '',
    },
]);

/**
 * `queryLocalFonts` is Chromium-only and missing from TypeScript's DOM types, so it's looked up by
 * name.
 */
function findLocalFontsQuery() {
    const query: unknown = Reflect.get(globalThis, 'queryLocalFonts');
    return check.isFunction(query) ? query : undefined;
}

export function canQueryLocalFonts() {
    return !!findLocalFontsQuery();
}

/**
 * The family of every font installed on the machine, sorted and without duplicates (the browser
 * lists each style of a family separately). Prompts the user for permission the first time.
 */
export async function queryLocalFontFamilies() {
    const query = findLocalFontsQuery();
    if (!query) {
        throw new Error('This browser cannot list installed fonts.');
    }
    const fonts: unknown = await query.call(globalThis);
    assertValidShape(
        fonts,
        localFontsShape,
        {
            allowExtraKeys: true,
        },
        'The browser listed installed fonts in an unexpected format.',
    );
    return removeDuplicates(fonts.map((font) => font.family)).toSorted((first, second) => {
        return first.localeCompare(second);
    });
}

/**
 * Whether every glyph of the family is the same width. A family that isn't installed renders in the
 * fallback sans-serif font, which isn't.
 */
export function isMonospaceFamily(family: string) {
    const context = document.createElement('canvas').getContext('2d');
    if (!context) {
        return false;
    }
    context.font = `16px ${JSON.stringify(family)}, sans-serif`;
    const widths = [
        'i',
        'm',
        'W',
        '.',
    ].map((character) => context.measureText(character).width);
    return widths.every((width) => width === widths[0]);
}
