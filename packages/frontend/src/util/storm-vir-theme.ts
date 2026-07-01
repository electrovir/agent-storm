/**
 * Storm's brand-level theme tokens that layer on top of vira's color theme. The raw palette stops
 * (--gray-50, --indigo-500, …) and non-color tokens (radii, spacing, typography) live statically in
 * `www-static/index.css` because they don't change between modes. The semantic surface tokens
 * (--bg, --fg, --sidebar-bg, …) DO change, so we apply them via a `<style>` element here.
 *
 * Two stylesheets are managed by `applyAllCssVars`:
 *
 * 1. The vira color theme (via `applyColorThemeViaStyleElement`). Vira's tokens get either the default
 *    light values or the `viraThemeDarkOverride` values depending on `useDark`.
 * 2. Our brand overrides (via `applyCssVarsViaStyleElement`). These read the palette stops out of
 *    `:root` (--gray-800 etc.) so we only have to maintain the value-to-stop mapping here.
 *
 * Mode switching is driven by the `ThemeClient` in `./theme.js`; this module is the dumb "render
 * the tokens" layer.
 */
import {applyCssVarsViaStyleElement} from 'lit-css-vars';
import {applyColorThemeViaStyleElement} from 'theme-vir';
import {viraTheme, viraThemeDarkOverride} from 'vira';

const brandStyleId = 'storm-brand-style';

const sharedBrandVars: Readonly<Record<string, string>> = {
    '--accent-solid': 'var(--indigo-600)',
    '--accent-solid-hover': 'var(--indigo-700)',
    '--accent-contrast': 'var(--white)',
    '--sidebar-accent-rail': 'var(--copper)',
};

const lightBrandVars: Readonly<Record<string, string>> = {
    ...sharedBrandVars,

    '--bg': 'var(--white)',
    '--bg-muted': 'var(--gray-50)',
    '--bg-subtle': 'var(--gray-100)',
    '--bg-emphasized': 'var(--gray-200)',
    '--bg-panel': 'var(--white)',
    '--bg-overlay': 'color-mix(in srgb, var(--white) 95%, transparent)',
    '--bg-backdrop': 'oklch(0 0 0 / 0.3)',
    '--bg-error': 'var(--red-50)',
    '--bg-warning': 'var(--orange-100)',
    '--bg-success': 'var(--green-100)',
    '--bg-info': 'var(--blue-100)',

    '--fg': 'var(--gray-900)',
    '--fg-muted': 'var(--gray-500)',
    '--fg-subtle': 'var(--gray-600)',
    '--fg-emphasized': 'var(--gray-950)',
    '--fg-inverted': 'var(--white)',
    '--fg-error': 'var(--red-700)',
    '--fg-warning': 'var(--orange-700)',
    '--fg-success': 'var(--green-700)',
    '--fg-info': 'var(--blue-700)',

    '--border': 'var(--gray-200)',
    '--border-muted': 'var(--gray-100)',
    '--border-subtle': 'var(--gray-100)',
    '--border-emphasized': 'var(--gray-300)',
    '--border-error': 'var(--red-500)',

    '--sidebar-bg': 'var(--gray-100)',
    '--sidebar-fg': 'var(--gray-800)',
    '--sidebar-fg-muted': 'var(--gray-700)',
    '--sidebar-fg-subtle': 'var(--gray-600)',
    '--sidebar-fg-faint': 'oklch(0.551 0.027 264.364 / 0.6)',
    '--sidebar-border': 'var(--gray-200)',
    '--sidebar-border-2': 'var(--gray-300)',
    '--sidebar-accent-bg': 'oklch(0.872 0.01 258.338 / 0.6)',
    '--sidebar-accent-bg-hover': 'oklch(0.872 0.01 258.338 / 0.35)',
    '--sidebar-accent-fg': 'var(--gray-950)',

    '--accent-fg': 'var(--indigo-700)',
    '--accent-muted': 'var(--indigo-50)',
    '--accent-subtle': 'var(--indigo-100)',
    '--accent-emphasized': 'var(--indigo-200)',
    '--accent-focus-ring': 'var(--indigo-500)',

    '--shadow-xs': '0px 1px 1px oklch(0 0 0 / 0.08), 0px 0px 1px inset oklch(0 0 0 / 0.05)',
    '--shadow-sm': '0px 2px 4px oklch(0 0 0 / 0.08), 0px 0px 1px inset oklch(0 0 0 / 0.05)',
    '--shadow-md': '0px 4px 8px oklch(0 0 0 / 0.1), 0px 0px 1px inset oklch(0 0 0 / 0.05)',
    '--shadow-lg': '0px 8px 16px oklch(0 0 0 / 0.12), 0px 0px 1px inset oklch(0 0 0 / 0.05)',
    '--shadow-xl': '0px 16px 24px oklch(0 0 0 / 0.14), 0px 0px 1px inset oklch(0 0 0 / 0.05)',

    '--vira-default-bg': 'var(--bg)',
    '--vira-default-fg': 'var(--fg)',
    '--vira-form-background-color': 'var(--bg-muted)',
    '--vira-form-foreground-color': 'var(--fg)',
    '--vira-form-placeholder-color': 'var(--fg-muted)',
    '--vira-form-border-color': 'var(--border-emphasized)',
    '--vira-form-secondary-body-foreground': 'var(--fg-muted)',
    '--vira-form-modal-backdrop-color': 'var(--bg-backdrop)',
    '--vira-form-selection-hover-color': 'color-mix(in srgb, var(--copper) 16%, transparent)',
    '--vira-form-selection-active-color': 'color-mix(in srgb, var(--copper) 26%, transparent)',

    '--terminal-bg': '#ffffff',
};

const darkBrandVars: Readonly<Record<string, string>> = {
    ...sharedBrandVars,

    '--bg': 'var(--black)',
    '--bg-muted': 'var(--gray-950)',
    '--bg-subtle': 'var(--gray-900)',
    '--bg-emphasized': 'var(--gray-800)',
    '--bg-panel': 'var(--gray-950)',
    '--bg-overlay': 'color-mix(in srgb, var(--gray-950) 95%, transparent)',
    '--bg-backdrop': 'oklch(0 0 0 / 0.45)',
    '--bg-error': 'var(--red-950)',
    '--bg-warning': 'var(--orange-950)',
    '--bg-success': 'var(--green-950)',
    '--bg-info': 'var(--blue-950)',

    '--fg': 'var(--gray-50)',
    '--fg-muted': 'var(--gray-500)',
    '--fg-subtle': 'var(--gray-400)',
    '--fg-emphasized': 'var(--gray-200)',
    '--fg-inverted': 'var(--black)',
    '--fg-error': 'var(--red-400)',
    '--fg-warning': 'var(--orange-300)',
    '--fg-success': 'var(--green-300)',
    '--fg-info': 'var(--blue-300)',

    '--border': 'var(--gray-800)',
    '--border-muted': 'var(--gray-950)',
    '--border-subtle': 'var(--gray-900)',
    '--border-emphasized': 'var(--gray-700)',
    '--border-error': 'var(--red-500)',

    '--sidebar-bg': 'var(--gray-900)',
    '--sidebar-fg': 'var(--gray-200)',
    '--sidebar-fg-muted': 'oklch(0.928 0.006 264.531 / 0.7)',
    '--sidebar-fg-subtle': 'oklch(0.872 0.01 258.338 / 0.75)',
    '--sidebar-fg-faint': 'oklch(0.707 0.022 261.325 / 0.6)',
    '--sidebar-border': 'var(--gray-800)',
    '--sidebar-border-2': 'var(--gray-700)',
    '--sidebar-accent-bg': 'oklch(0.278 0.033 256.848 / 0.6)',
    '--sidebar-accent-bg-hover': 'oklch(0.278 0.033 256.848 / 0.4)',
    '--sidebar-accent-fg': 'var(--gray-50)',

    '--accent-fg': 'var(--indigo-300)',
    '--accent-muted': 'var(--indigo-950)',
    '--accent-subtle': 'var(--indigo-900)',
    '--accent-emphasized': 'var(--indigo-800)',
    '--accent-focus-ring': 'var(--indigo-600)',

    '--shadow-xs':
        '0px 1px 1px oklch(0 0 0 / 0.64), 0px 0px 1px inset oklch(0.872 0.01 258.338 / 0.2)',
    '--shadow-sm':
        '0px 2px 4px oklch(0 0 0 / 0.64), 0px 0px 1px inset oklch(0.872 0.01 258.338 / 0.3)',
    '--shadow-md':
        '0px 4px 8px oklch(0 0 0 / 0.64), 0px 0px 1px inset oklch(0.872 0.01 258.338 / 0.3)',
    '--shadow-lg':
        '0px 8px 16px oklch(0 0 0 / 0.64), 0px 0px 1px inset oklch(0.872 0.01 258.338 / 0.3)',
    '--shadow-xl':
        '0px 16px 24px oklch(0 0 0 / 0.64), 0px 0px 1px inset oklch(0.872 0.01 258.338 / 0.3)',

    '--vira-default-bg': 'var(--bg-muted)',
    '--vira-default-fg': 'var(--fg)',
    '--vira-form-background-color': 'var(--bg-emphasized)',
    '--vira-form-foreground-color': 'var(--fg)',
    '--vira-form-placeholder-color': 'var(--fg-muted)',
    '--vira-form-border-color': 'var(--border-emphasized)',
    '--vira-form-secondary-body-foreground': 'var(--fg-muted)',
    '--vira-form-modal-backdrop-color': 'var(--bg-backdrop)',
    '--vira-form-selection-hover-color': 'color-mix(in srgb, var(--copper) 22%, transparent)',
    '--vira-form-selection-active-color': 'color-mix(in srgb, var(--copper) 32%, transparent)',

    '--terminal-bg': '#111111',
};

/**
 * Apply both the vira color theme and our brand overrides for the chosen mode. Both stylesheets are
 * keyed by stable ids and reused on subsequent calls, so flipping `useDark` simply rewrites the
 * existing `<style>` elements — no flash, no class on `<html>`.
 */
export function applyAllCssVars({useDark}: Readonly<{useDark: boolean}>): void {
    applyColorThemeViaStyleElement(viraTheme, useDark ? viraThemeDarkOverride : undefined);
    applyCssVarsViaStyleElement(useDark ? darkBrandVars : lightBrandVars, brandStyleId);
    /**
     * `color-scheme` controls native UA widgets (scrollbars, form controls, the `<dialog>` backdrop
     * default). It is a regular CSS property — not a custom prop — so it lives on the root element
     * directly rather than going through the brand stylesheet.
     */
    document.documentElement.style.colorScheme = useDark ? 'dark' : 'light';
}
