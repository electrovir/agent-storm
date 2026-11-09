/**
 * Cmd+T or Ctrl+T, either modifier on any platform. Shift is excluded so the browser's "reopen
 * closed tab" (Cmd+Shift+T) is left alone, and held-key repeats are ignored so holding the keys
 * doesn't open a tab per repeat.
 */
export function isNewTabShortcut(event: Readonly<KeyboardEvent>) {
    return (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        event.key.toLowerCase() === 't'
    );
}

/** Cmd+, or Ctrl+, the usual "open settings" shortcut, either modifier on any platform. */
export function isSettingsShortcut(event: Readonly<KeyboardEvent>) {
    return (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        event.key === ','
    );
}
