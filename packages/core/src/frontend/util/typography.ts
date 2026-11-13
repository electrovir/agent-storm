// cspell:words hyperlegible meslo menlo
import {FontRole, type Settings} from '@agent-storm/common';
import {clamp, getEnumValues, mapObjectValues} from '@augment-vir/common';
import {unsafeCSS, type CSSResult} from 'element-vir';

/** The sizes, in pixels, that a role's size setting accepts. */
export const fontSizeLimits: Readonly<Record<FontRole, Readonly<{min: number; max: number}>>> = {
    [FontRole.Interface]: {
        min: 12,
        max: 20,
    },
    [FontRole.Prompt]: {
        min: 12,
        max: 20,
    },
    [FontRole.Code]: {
        min: 10,
        max: 18,
    },
    [FontRole.Terminal]: {
        min: 8,
        max: 20,
    },
};

/**
 * The role whose font a role uses while "Separate fonts" is off. A role no other role follows has
 * its own font either way.
 */
export const fontRoleFollows: Readonly<Record<FontRole, FontRole | undefined>> = {
    [FontRole.Interface]: undefined,
    [FontRole.Prompt]: FontRole.Interface,
    [FontRole.Code]: undefined,
    [FontRole.Terminal]: FontRole.Code,
};

const interfaceFontStack = "'Atkinson Hyperlegible Next', ui-sans-serif, system-ui, sans-serif";
const monospaceFontStack = "'MesloLGS NF', Menlo, monospace";

/** What follows a chosen family, so a family that isn't installed falls back to the app's font. */
export const defaultFontFamilies: Readonly<Record<FontRole, string>> = {
    [FontRole.Interface]: interfaceFontStack,
    [FontRole.Prompt]: interfaceFontStack,
    [FontRole.Code]: monospaceFontStack,
    [FontRole.Terminal]: monospaceFontStack,
};

/** Whether a role's family picker lists only monospace fonts. */
export const fontRoleIsMonospace: Readonly<Record<FontRole, boolean>> = {
    [FontRole.Interface]: false,
    [FontRole.Prompt]: false,
    [FontRole.Code]: true,
    [FontRole.Terminal]: true,
};

/** The font a role shows when its settings are unset, so a preview can approximate it. */
export const defaultFontPreviewSizes: Readonly<Record<FontRole, number>> = {
    [FontRole.Interface]: 16,
    [FontRole.Prompt]: 14,
    [FontRole.Code]: 11,
    [FontRole.Terminal]: 13,
};

/** Undefined fields mean the role keeps the app's own font. */
export type ResolvedFont = Readonly<{
    /** A complete `font-family` value: the chosen family, then the app's default stack. */
    familyCss: string | undefined;
    sizePx: number | undefined;
}>;

export type ResolvedFonts = Readonly<Record<FontRole, ResolvedFont>>;

/**
 * The font each role renders with. A role that follows another while "Separate fonts" is off takes
 * that role's settings, with its own size limits applied.
 */
export function resolveFonts(typography: Readonly<Settings['typography']> | undefined) {
    return mapObjectValues(fontSizeLimits, (role, limits): ResolvedFont => {
        const followed = fontRoleFollows[role];
        const source = followed && !typography?.separateFonts ? followed : role;
        const family = typography?.[source].family.trim();
        const size = typography?.[source].size;
        return {
            familyCss: family
                ? `${JSON.stringify(family)}, ${defaultFontFamilies[source]}`
                : undefined,
            sizePx: size ? clamp(size, limits) : undefined,
        };
    });
}

const fontCssVars: Readonly<Record<FontRole, Readonly<{family: string; size: string}>>> = {
    [FontRole.Interface]: {
        family: '--as-font-interface-family',
        size: '--as-font-interface-size',
    },
    [FontRole.Prompt]: {
        family: '--as-font-prompt-family',
        size: '--as-font-prompt-size',
    },
    [FontRole.Code]: {
        family: '--as-font-code-family',
        size: '--as-font-code-size',
    },
    [FontRole.Terminal]: {
        family: '--as-font-terminal-family',
        size: '--as-font-terminal-size',
    },
};

/**
 * A `font-family` value that is the role's chosen font while one is set, and `fallback` (the
 * element's own font) otherwise.
 */
export function fontFamilyVar({
    role,
    fallback,
}: Readonly<{role: FontRole; fallback: string}>): CSSResult {
    return unsafeCSS(`var(${fontCssVars[role].family}, ${fallback})`);
}

/**
 * A `font-size` value that is the role's chosen size while one is set, and `fallback` (the
 * element's own size) otherwise.
 */
export function fontSizeVar({
    role,
    fallback,
}: Readonly<{role: FontRole; fallback: string}>): CSSResult {
    return unsafeCSS(`var(${fontCssVars[role].size}, ${fallback})`);
}

const typographyState: {
    fonts: ResolvedFonts;
    listeners: Set<(fonts: ResolvedFonts) => void>;
} = {
    fonts: resolveFonts(undefined),
    listeners: new Set(),
};

/**
 * Fonts that CSS variables can't reach, such as a terminal's, read the current ones from here and
 * subscribe to changes.
 */
export function getResolvedFonts(): ResolvedFonts {
    return typographyState.fonts;
}

/** Returns an unsubscribe callback. Call it on element cleanup. */
export function listenToTypography(listener: (fonts: ResolvedFonts) => void): () => void {
    typographyState.listeners.add(listener);
    return () => {
        typographyState.listeners.delete(listener);
    };
}

/**
 * Sets the font smoothing and each role's CSS variables on the document, then tells subscribers
 * when the fonts changed.
 */
export function applyTypography(settings: Readonly<Pick<Settings, 'typography'>> | undefined) {
    const root = document.documentElement;
    const smoothing = settings?.typography.fontSmoothing;
    setOrRemoveProperty({
        element: root,
        name: '-webkit-font-smoothing',
        value: smoothing ? 'antialiased' : undefined,
    });
    setOrRemoveProperty({
        element: root,
        name: '-moz-osx-font-smoothing',
        value: smoothing ? 'grayscale' : undefined,
    });
    const fonts = resolveFonts(settings?.typography);
    if (
        isSameFonts({
            first: typographyState.fonts,
            second: fonts,
        })
    ) {
        return;
    }
    getEnumValues(FontRole).forEach((role) => {
        setOrRemoveProperty({
            element: root,
            name: fontCssVars[role].family,
            value: fonts[role].familyCss,
        });
        setOrRemoveProperty({
            element: root,
            name: fontCssVars[role].size,
            value: fonts[role].sizePx ? `${fonts[role].sizePx}px` : undefined,
        });
    });
    typographyState.fonts = fonts;
    typographyState.listeners.forEach((listener) => listener(fonts));
}

function isSameFonts({first, second}: Readonly<{first: ResolvedFonts; second: ResolvedFonts}>) {
    return getEnumValues(FontRole).every((role) => {
        return (
            first[role].familyCss === second[role].familyCss &&
            first[role].sizePx === second[role].sizePx
        );
    });
}

function setOrRemoveProperty({
    element,
    name,
    value,
}: {
    element: HTMLElement;
    name: string;
    value: string | undefined;
}) {
    if (value) {
        element.style.setProperty(name, value);
    } else {
        element.style.removeProperty(name);
    }
}
