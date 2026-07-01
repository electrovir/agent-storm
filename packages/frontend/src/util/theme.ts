/**
 * Runtime dark/light mode controller. Owns:
 *
 * 1. The user's saved selection ({@link UserThemeSelection} — Auto, Light, or Dark) persisted in
 *    `localStorage` so the choice survives reload.
 * 2. The OS-level `prefers-color-scheme` media query, watched so the resolved mode tracks the OS while
 *    the selection is Auto.
 * 3. Applying both vira's color theme and our brand overrides through {@link applyAllCssVars} from
 *    `./storm-vir-theme.js`.
 *
 * All UI reads `themeClient.getSelection()` and listens via `themeClient.subscribe()` for the
 * resolved (effective) mode. The vir-appearance-section toggle calls
 * `themeClient.applyTheme(next)`.
 */
import {UserThemeSelection} from '@agent-storm/common';
import {applyAllCssVars} from './storm-vir-theme.js';

export type EffectiveTheme = 'dark' | 'light';

const storageKey = 'agent-storm.theme';

function readStoredSelection(): UserThemeSelection {
    const raw = window.localStorage.getItem(storageKey);
    if (
        raw === UserThemeSelection.Auto ||
        raw === UserThemeSelection.Dark ||
        raw === UserThemeSelection.Light
    ) {
        return raw;
    }
    return UserThemeSelection.Auto;
}

export class ThemeClient {
    private selection: UserThemeSelection;
    private effective: EffectiveTheme;
    private readonly darkMedia: MediaQueryList;
    private readonly listeners = new Set<(theme: EffectiveTheme) => void>();

    constructor() {
        this.selection = readStoredSelection();
        this.darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
        this.effective = this.resolveEffective();
        /**
         * When the selection is Auto, the OS preference IS the effective mode. We listen for
         * changes even when the user has pinned Light or Dark — switching back to Auto later should
         * pick up the OS state without forcing a reload.
         */
        this.darkMedia.addEventListener('change', this.handleOsChange);
        applyAllCssVars({
            useDark: this.effective === 'dark',
        });
    }

    public getSelection(): UserThemeSelection {
        return this.selection;
    }

    public getEffectiveTheme(): EffectiveTheme {
        return this.effective;
    }

    /**
     * Apply a new selection: persist it, recompute the effective mode, swap the CSS-var
     * stylesheets, and notify subscribers if the effective mode changed.
     */
    public applyTheme(next: UserThemeSelection): void {
        this.selection = next;
        window.localStorage.setItem(storageKey, next);
        this.syncEffective();
    }

    public subscribe(listener: (theme: EffectiveTheme) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private resolveEffective(): EffectiveTheme {
        if (this.selection === UserThemeSelection.Dark) {
            return 'dark';
        } else if (this.selection === UserThemeSelection.Light) {
            return 'light';
        }
        return this.darkMedia.matches ? 'dark' : 'light';
    }

    private syncEffective(): void {
        const next = this.resolveEffective();
        applyAllCssVars({
            useDark: next === 'dark',
        });
        if (next === this.effective) {
            return;
        }
        this.effective = next;
        this.listeners.forEach((listener) => listener(next));
    }

    private readonly handleOsChange = (): void => {
        if (this.selection === UserThemeSelection.Auto) {
            this.syncEffective();
        }
    };
}

/**
 * Single process-wide client. Created eagerly so the first paint already has the correct theme
 * applied — boot order is: `index.html` loads `vir-app.element.ts`, which imports this module, and
 * the `ThemeClient` constructor runs before any element styles are computed.
 */
export const themeClient = new ThemeClient();
