import {defaultSettings, ThreadOrigin} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {AiProvider, buildPluginId, ReasoningEffort} from '../build-api.js';
import {
    readModelDefaults,
    resolveThreadModelDefault,
    writeModelDefaults,
    type ModelDefault,
    type ModelDefaults,
} from './model-default-settings.js';

const folderDefault: ModelDefault = {
    provider: AiProvider.Codex,
    model: 'gpt-5',
    effort: undefined,
};

const watchDefault: ModelDefault = {
    provider: AiProvider.Claude,
    model: 'claude-sonnet',
    effort: ReasoningEffort.Low,
};

const defaults: ModelDefaults = {
    global: {
        provider: AiProvider.Claude,
        model: '',
        effort: ReasoningEffort.High,
    },
    folders: {
        '/repos/example': folderDefault,
    },
    origins: {
        [ThreadOrigin.Watch]: watchDefault,
    },
};

describe(readModelDefaults.name, () => {
    it('reads back what writeModelDefaults stored', () => {
        assert.deepEquals(
            readModelDefaults(
                writeModelDefaults({
                    settings: defaultSettings,
                    defaults,
                }),
            ),
            defaults,
        );
    });

    it('reads defaults stored before origins existed', () => {
        assert.deepEquals(
            readModelDefaults({
                pluginSettings: {
                    [`${buildPluginId}:model-defaults`]: {
                        global: defaults.global,
                        folders: {},
                    },
                },
            }),
            {
                global: defaults.global,
                folders: {},
            },
        );
    });

    it('falls back to no defaults when the stored value is malformed', () => {
        assert.deepEquals(
            readModelDefaults({
                pluginSettings: {
                    [`${buildPluginId}:model-defaults`]: {
                        global: 'claude',
                    },
                },
            }),
            {
                global: undefined,
                folders: {},
                origins: undefined,
            },
        );
    });
});

describe(resolveThreadModelDefault.name, () => {
    it("prefers the origin's model over the folder's", () => {
        assert.deepEquals(
            resolveThreadModelDefault({
                defaults,
                folder: '/repos/example',
                origin: ThreadOrigin.Watch,
            }),
            watchDefault,
        );
    });

    it("uses the folder's default for an origin without a model", () => {
        assert.deepEquals(
            resolveThreadModelDefault({
                defaults,
                folder: '/repos/example',
                origin: ThreadOrigin.Review,
            }),
            folderDefault,
        );
    });

    it("falls back to Claude's default model when nothing is set", () => {
        assert.deepEquals(
            resolveThreadModelDefault({
                defaults: {
                    global: undefined,
                    folders: {},
                    origins: undefined,
                },
                folder: '/repos/example',
                origin: ThreadOrigin.Review,
            }),
            {
                provider: AiProvider.Claude,
                model: '',
                effort: undefined,
                speedTier: undefined,
            },
        );
    });
});
