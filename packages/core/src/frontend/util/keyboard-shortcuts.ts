// cspell:words backquote

import {type Settings} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    getObjectTypedEntries,
    getObjectTypedKeys,
    getObjectTypedValues,
    mapObjectValues,
    omitObjectKeys,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {checkValidShape, defineShape, optionalShape} from 'object-shape-tester';

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

/** Which set of keyboard shortcuts applies. Mac keyboards lead with Cmd where others use Ctrl. */
export enum KeyboardPlatform {
    Mac = 'mac',
    /** Windows, Linux, and everything else that isn't a Mac. */
    Other = 'other',
}

/** The platform of the browser this runs in. iPads report as Mac, which suits their keyboards. */
export const currentKeyboardPlatform = navigator.userAgent.includes('Mac')
    ? KeyboardPlatform.Mac
    : KeyboardPlatform.Other;

/**
 * One key combination. `code` is the physical key, as `KeyboardEvent.code` names it, so Option on
 * Mac (which changes the typed character) can't change what matches.
 */
export const keyboardShortcutShape = defineShape({
    code: '',
    metaKey: optionalShape(false, {
        alsoUndefined: true,
    }),
    ctrlKey: optionalShape(false, {
        alsoUndefined: true,
    }),
    altKey: optionalShape(false, {
        alsoUndefined: true,
    }),
    shiftKey: optionalShape(false, {
        alsoUndefined: true,
    }),
});

export type KeyboardShortcut = typeof keyboardShortcutShape.runtimeType;

/**
 * Something a plugin lets the user trigger from the keyboard. The Keyboard shortcuts page of the
 * Settings modal lists it, where the user can replace its defaults with any number of their own.
 * Only the current {@link KeyboardPlatform}'s shortcuts are shown, stored, or matched.
 */
export type ShortcutAction = Readonly<{
    /** Prefixed by the owning plugin's id, so no two plugins' actions can collide. */
    id: string;
    pluginId: string;
    label: string;
    description: string;
    defaults: Readonly<Record<KeyboardPlatform, ReadonlyArray<KeyboardShortcut>>>;
}>;

/** Types a plugin's shortcut action and prefixes its id with the plugin's. */
export function defineShortcutAction({
    name,
    ...action
}: Readonly<
    Omit<ShortcutAction, 'id'> & {
        name: string;
    }
>): ShortcutAction {
    return {
        ...action,
        id: `${action.pluginId}:${name}`,
    };
}

/** Keys that send different codes but should match as one. */
const sameKeyCodes: Readonly<Record<string, string>> = {
    NumpadEnter: 'Enter',
};

function normalizeCode(code: string) {
    return sameKeyCodes[code] || code;
}

/** Whether two shortcuts press the same key with the same modifiers. */
export function isSameShortcut({
    first,
    second,
}: Readonly<{
    first: Readonly<KeyboardShortcut>;
    second: Readonly<KeyboardShortcut>;
}>) {
    return (
        first.code === second.code &&
        !!first.metaKey === !!second.metaKey &&
        !!first.ctrlKey === !!second.ctrlKey &&
        !!first.altKey === !!second.altKey &&
        !!first.shiftKey === !!second.shiftKey
    );
}

/** Whether `event` is one of `shortcuts`, with exactly its modifiers held. */
export function matchesShortcut({
    event,
    shortcuts,
}: Readonly<{
    event: Readonly<KeyboardEvent>;
    shortcuts: ReadonlyArray<KeyboardShortcut>;
}>) {
    return shortcuts.some((shortcut) => {
        return (
            shortcut.code === normalizeCode(event.code) &&
            !!shortcut.metaKey === event.metaKey &&
            !!shortcut.ctrlKey === event.ctrlKey &&
            !!shortcut.altKey === event.altKey &&
            !!shortcut.shiftKey === event.shiftKey
        );
    });
}

const modifierCodes = [
    'MetaLeft',
    'MetaRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'ShiftLeft',
    'ShiftRight',
    'CapsLock',
    'Fn',
];

/** The shortcut `event` presses. Undefined while only modifiers are down. */
export function readShortcutFromEvent(
    event: Readonly<KeyboardEvent>,
): KeyboardShortcut | undefined {
    if (!event.code || modifierCodes.includes(event.code)) {
        return undefined;
    }
    return {
        code: normalizeCode(event.code),
        metaKey: event.metaKey || undefined,
        ctrlKey: event.ctrlKey || undefined,
        altKey: event.altKey || undefined,
        shiftKey: event.shiftKey || undefined,
    };
}

type ModifierKey = Exclude<keyof KeyboardShortcut, 'code'>;

/** Each platform's modifier names, in the order that platform writes them. */
const modifierLabels: Readonly<
    Record<KeyboardPlatform, ReadonlyArray<Readonly<{key: ModifierKey; label: string}>>>
> = {
    [KeyboardPlatform.Mac]: [
        {
            key: 'metaKey',
            label: 'Cmd',
        },
        {
            key: 'ctrlKey',
            label: 'Ctrl',
        },
        {
            key: 'altKey',
            label: 'Option',
        },
        {
            key: 'shiftKey',
            label: 'Shift',
        },
    ],
    [KeyboardPlatform.Other]: [
        {
            key: 'ctrlKey',
            label: 'Ctrl',
        },
        {
            key: 'altKey',
            label: 'Alt',
        },
        {
            key: 'shiftKey',
            label: 'Shift',
        },
        {
            key: 'metaKey',
            label: 'Meta',
        },
    ],
};

const codeLabels: Readonly<Record<string, string>> = {
    Backquote: '`',
    Backslash: '\\',
    BracketLeft: '[',
    BracketRight: ']',
    Comma: ',',
    Equal: '=',
    Minus: '-',
    Period: '.',
    Quote: "'",
    Semicolon: ';',
    Slash: '/',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
};

/** Like "Cmd+Ctrl+A", in the current platform's words. */
export function formatShortcut(shortcut: Readonly<KeyboardShortcut>) {
    return [
        ...modifierLabels[currentKeyboardPlatform]
            .filter((modifier) => shortcut[modifier.key])
            .map((modifier) => modifier.label),
        codeLabels[shortcut.code] || shortcut.code.replace(/^(Key|Digit)/, ''),
    ].join('+');
}

/** `label` followed by its shortcuts, like "Archive thread [Cmd+Ctrl+A]", for a tooltip. */
export function withShortcutHint(label: string, shortcuts: ReadonlyArray<KeyboardShortcut>) {
    return shortcuts.length
        ? `${label} [${shortcuts.map((shortcut) => formatShortcut(shortcut)).join(', ')}]`
        : label;
}

function isShortcutList(value: unknown): value is ReadonlyArray<KeyboardShortcut> {
    return (
        check.isArray(value) &&
        value.every((entry) => checkValidShape(entry, keyboardShortcutShape))
    );
}

/** The user's own shortcuts for `action` on this platform. Undefined when they kept its defaults. */
function readStoredShortcuts({
    action,
    settings,
}: Readonly<{
    action: Readonly<Pick<ShortcutAction, 'id'>>;
    settings: Readonly<Pick<Settings, 'keyboardShortcuts'>> | undefined;
}>) {
    const entry: Readonly<Record<string, unknown>> | undefined =
        settings?.keyboardShortcuts?.[action.id];
    const stored = entry?.[currentKeyboardPlatform];
    return isShortcutList(stored) ? stored : undefined;
}

/**
 * `action`'s shortcuts on this platform: the user's own, or its defaults when they have none or
 * theirs are invalid. The server can't check them against an external plugin's actions, so this is
 * where stored shortcuts are validated.
 */
export function resolveShortcuts({
    action,
    settings,
}: Readonly<{
    action: Readonly<Pick<ShortcutAction, 'id' | 'defaults'>>;
    settings: Readonly<Pick<Settings, 'keyboardShortcuts'>> | undefined;
}>) {
    return (
        readStoredShortcuts({
            action,
            settings,
        }) || action.defaults[currentKeyboardPlatform]
    );
}

/**
 * Stores `shortcuts` as `action`'s on this platform, leaving the other platform's alone. Shortcuts
 * equal to the defaults aren't stored, so a later change to a default still reaches the user. An
 * empty list is stored, since it means the user removed every shortcut.
 */
export function writeShortcuts({
    action,
    settings,
    shortcuts,
}: Readonly<{
    action: Readonly<Pick<ShortcutAction, 'id' | 'defaults'>>;
    settings: Readonly<Settings>;
    shortcuts: ReadonlyArray<KeyboardShortcut>;
}>): Settings {
    const allStored = settings.keyboardShortcuts || {};
    const storedEntry: Readonly<Record<string, unknown>> = allStored[action.id] || {};
    const otherPlatforms = omitObjectKeys(storedEntry, [
        currentKeyboardPlatform,
    ]);
    const actionEntry = check.deepEquals(shortcuts, action.defaults[currentKeyboardPlatform])
        ? otherPlatforms
        : {
              ...otherPlatforms,
              [currentKeyboardPlatform]: shortcuts,
          };
    const others = omitObjectKeys(allStored, [action.id]);
    return {
        ...settings,
        keyboardShortcuts: getObjectTypedKeys(actionEntry).length
            ? {
                  ...others,
                  [action.id]: actionEntry,
              }
            : others,
    };
}

/** Whether any action has shortcuts of the user's own on this platform. */
export function areShortcutsModified(settings: Readonly<Pick<Settings, 'keyboardShortcuts'>>) {
    return getObjectTypedValues(settings.keyboardShortcuts || {}).some((entry) => {
        return check.hasKey(entry, currentKeyboardPlatform);
    });
}

/** Puts every action back to its default shortcuts on this platform. */
export function restoreShortcuts(settings: Readonly<Settings>): Settings {
    const restored = mapObjectValues(
        settings.keyboardShortcuts || {},
        (_actionId, entry: Readonly<Record<string, unknown>>) => {
            return omitObjectKeys(entry, [currentKeyboardPlatform]);
        },
    );
    return {
        ...settings,
        keyboardShortcuts: typedObjectFromEntries(
            getObjectTypedEntries(restored).filter(
                ([
                    ,
                    entry,
                ]) => getObjectTypedKeys(entry).length,
            ),
        ),
    };
}
