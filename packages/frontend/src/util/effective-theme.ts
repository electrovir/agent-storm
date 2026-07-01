export type EffectiveTheme = 'dark' | 'light';

let current: EffectiveTheme = 'dark';
const listeners = new Set<(theme: EffectiveTheme) => void>();

export function setEffectiveTheme(next: EffectiveTheme): void {
    if (next === current) {
        return;
    }
    current = next;
    listeners.forEach((listener) => listener(next));
}

export function getEffectiveTheme(): EffectiveTheme {
    return current;
}

export function subscribeEffectiveTheme(listener: (theme: EffectiveTheme) => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
