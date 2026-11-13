import {defaultSettings, type Settings} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    definePluginSettings,
    isPluginSettingsModified,
    PluginSettingKind,
    resolvePluginSettings,
    restorePluginSettings,
    writePluginSetting,
} from './plugin-settings.js';

const exampleSettings = definePluginSettings({
    isLoud: {
        kind: PluginSettingKind.Boolean,
        label: 'Loud',
        description: 'Makes noise.',
        default: true,
    },
    nickname: {
        kind: PluginSettingKind.String,
        label: 'Nickname',
        description: 'What to call it.',
        default: 'none',
    },
    retries: {
        kind: PluginSettingKind.Number,
        label: 'Retries',
        description: 'How many.',
        default: 3,
        min: 1,
        max: 5,
    },
    mode: {
        kind: PluginSettingKind.Select,
        label: 'Mode',
        description: 'How it runs.',
        options: [
            {
                value: 'fast',
                label: 'Fast',
            },
            {
                value: 'slow',
                label: 'Slow',
            },
        ],
        default: 'fast',
    },
    ignored: {
        kind: PluginSettingKind.StringList,
        label: 'Ignored',
        description: 'What to skip.',
        default: [],
    },
});

const examplePlugin = {
    id: 'example',
    settings: exampleSettings,
};

function createSettings(pluginSettings: Settings['pluginSettings']): Settings {
    return {
        ...defaultSettings,
        pluginSettings,
    };
}

const defaultValues = {
    isLoud: true,
    nickname: 'none',
    retries: 3,
    mode: 'fast' as const,
    ignored: [],
};

describe(resolvePluginSettings.name, () => {
    it('derives each value type from its definition', () => {
        const values = resolvePluginSettings({
            plugin: examplePlugin,
            settings: undefined,
        });

        assert.tsType(values).equals<
            Readonly<{
                isLoud: boolean;
                nickname: string;
                retries: number;
                mode: 'fast' | 'slow';
                ignored: ReadonlyArray<string>;
            }>
        >();
    });

    it('is the defaults when nothing is stored', () => {
        assert.deepEquals(
            resolvePluginSettings({
                plugin: examplePlugin,
                settings: undefined,
            }),
            defaultValues,
        );
        assert.deepEquals(
            resolvePluginSettings({
                plugin: examplePlugin,
                settings: createSettings({
                    other: {
                        isLoud: false,
                    },
                }),
            }),
            defaultValues,
        );
    });

    it('uses valid stored values', () => {
        assert.deepEquals(
            resolvePluginSettings({
                plugin: examplePlugin,
                settings: createSettings({
                    example: {
                        isLoud: false,
                        retries: 5,
                        mode: 'slow',
                        ignored: [
                            'a',
                        ],
                    },
                }),
            }),
            {
                isLoud: false,
                nickname: 'none',
                retries: 5,
                mode: 'slow',
                ignored: [
                    'a',
                ],
            },
        );
    });

    it('falls back to the default for each invalid stored value', () => {
        assert.deepEquals(
            resolvePluginSettings({
                plugin: examplePlugin,
                settings: createSettings({
                    example: {
                        isLoud: 'yes',
                        nickname: 4,
                        retries: 6,
                        mode: 'medium',
                        ignored: [
                            'a',
                            2,
                        ],
                        removedSetting: true,
                    },
                }),
            }),
            defaultValues,
        );
    });

    it('is empty for a plugin without settings', () => {
        assert.deepEquals(
            resolvePluginSettings({
                plugin: {
                    id: 'plain',
                },
                settings: undefined,
            }),
            {},
        );
    });
});

describe(definePluginSettings.name, () => {
    it('rejects a select default that is not one of its options', () => {
        const invalidSelect = {
            kind: PluginSettingKind.Select,
            label: 'Mode',
            description: 'How it runs.',
            options: [
                {
                    value: 'fast',
                    label: 'Fast',
                },
            ],
            default: 'slow',
        } as const;

        assert.throws(
            () => {
                // @ts-expect-error: the default must be one of the options' values
                definePluginSettings({
                    mode: invalidSelect,
                });
            },
            {
                matchMessage: "The default of 'mode' is not one of its options.",
            },
        );
    });
});

describe(writePluginSetting.name, () => {
    it('stores only values that differ from their default', () => {
        const changed = writePluginSetting({
            plugin: examplePlugin,
            settings: createSettings({
                other: {
                    kept: 1,
                },
            }),
            key: 'retries',
            value: 4,
        });
        assert.deepEquals(changed.pluginSettings, {
            other: {
                kept: 1,
            },
            example: {
                retries: 4,
            },
        });
        assert.deepEquals(
            writePluginSetting({
                plugin: examplePlugin,
                settings: changed,
                key: 'isLoud',
                value: false,
            }).pluginSettings?.example,
            {
                isLoud: false,
                retries: 4,
            },
        );
    });

    it('drops the plugin entry once every value is back to its default', () => {
        const changed = writePluginSetting({
            plugin: examplePlugin,
            settings: createSettings({}),
            key: 'nickname',
            value: 'x',
        });
        assert.deepEquals(
            writePluginSetting({
                plugin: examplePlugin,
                settings: changed,
                key: 'nickname',
                value: undefined,
            }).pluginSettings,
            {},
        );
    });

    it('ignores a value the setting does not accept', () => {
        const settings = createSettings({});
        assert.strictEquals(
            writePluginSetting({
                plugin: examplePlugin,
                settings,
                key: 'retries',
                value: 9,
            }),
            settings,
        );
    });
});

describe(restorePluginSettings.name, () => {
    it("clears only the plugin's own values", () => {
        const settings = createSettings({
            other: {
                kept: 1,
            },
            example: {
                retries: 4,
            },
        });
        assert.isTrue(
            isPluginSettingsModified({
                plugin: examplePlugin,
                settings,
            }),
        );
        const restored = restorePluginSettings({
            plugin: examplePlugin,
            settings,
        });
        assert.deepEquals(restored.pluginSettings, {
            other: {
                kept: 1,
            },
        });
        assert.isFalse(
            isPluginSettingsModified({
                plugin: examplePlugin,
                settings: restored,
            }),
        );
    });
});
