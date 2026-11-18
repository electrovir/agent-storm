import {defaultSettings} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    currentKeyboardPlatform,
    KeyboardPlatform,
    matchesShortcut,
    resolveShortcuts,
    restoreShortcuts,
    writeShortcuts,
    type ShortcutAction,
} from './keyboard-shortcuts.js';

const otherPlatform =
    currentKeyboardPlatform === KeyboardPlatform.Mac
        ? KeyboardPlatform.Other
        : KeyboardPlatform.Mac;

const action: Pick<ShortcutAction, 'id' | 'defaults'> = {
    id: 'test-plugin:archive',
    defaults: {
        [KeyboardPlatform.Mac]: [
            {
                code: 'KeyA',
                metaKey: true,
            },
        ],
        [KeyboardPlatform.Other]: [
            {
                code: 'KeyA',
                ctrlKey: true,
            },
        ],
    },
};

const customShortcuts = [
    {
        code: 'KeyB',
        altKey: true,
    },
];

describe(writeShortcuts.name, () => {
    it('stores custom shortcuts and keeps the other platform', () => {
        const settings = writeShortcuts({
            action,
            settings: {
                ...defaultSettings,
                keyboardShortcuts: {
                    [action.id]: {
                        [otherPlatform]: [],
                    },
                },
            },
            shortcuts: customShortcuts,
        });
        assert.deepEquals(settings.keyboardShortcuts, {
            [action.id]: {
                [otherPlatform]: [],
                [currentKeyboardPlatform]: customShortcuts,
            },
        });
    });

    it('removes the action when its shortcuts match the defaults', () => {
        const settings = writeShortcuts({
            action,
            settings: writeShortcuts({
                action,
                settings: defaultSettings,
                shortcuts: customShortcuts,
            }),
            shortcuts: action.defaults[currentKeyboardPlatform],
        });
        assert.deepEquals(settings.keyboardShortcuts, {});
    });

    it('stores an empty list instead of falling back to the defaults', () => {
        const settings = writeShortcuts({
            action,
            settings: defaultSettings,
            shortcuts: [],
        });
        assert.deepEquals(
            resolveShortcuts({
                action,
                settings,
            }),
            [],
        );
    });
});

describe(resolveShortcuts.name, () => {
    it('falls back to the defaults when the stored shortcuts are malformed', () => {
        assert.deepEquals(
            resolveShortcuts({
                action,
                settings: {
                    keyboardShortcuts: {
                        [action.id]: {
                            [currentKeyboardPlatform]: [
                                {
                                    key: 'b',
                                },
                            ],
                        },
                    },
                },
            }),
            action.defaults[currentKeyboardPlatform],
        );
    });
});

describe(restoreShortcuts.name, () => {
    it("clears this platform's shortcuts and keeps the other's", () => {
        assert.deepEquals(
            restoreShortcuts({
                ...defaultSettings,
                keyboardShortcuts: {
                    [action.id]: {
                        [currentKeyboardPlatform]: customShortcuts,
                        [otherPlatform]: customShortcuts,
                    },
                    'test-plugin:other': {
                        [currentKeyboardPlatform]: [],
                    },
                },
            }).keyboardShortcuts,
            {
                [action.id]: {
                    [otherPlatform]: customShortcuts,
                },
            },
        );
    });
});

describe(matchesShortcut.name, () => {
    it('matches NumpadEnter as Enter, with exactly the shortcut modifiers', () => {
        const shortcuts = [
            {
                code: 'Enter',
                metaKey: true,
            },
        ];
        assert.deepEquals(
            [
                new KeyboardEvent('keydown', {
                    code: 'NumpadEnter',
                    metaKey: true,
                }),
                new KeyboardEvent('keydown', {
                    code: 'Enter',
                    metaKey: true,
                    shiftKey: true,
                }),
            ].map((event) => {
                return matchesShortcut({
                    event,
                    shortcuts,
                });
            }),
            [
                true,
                false,
            ],
        );
    });
});
