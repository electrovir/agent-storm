import {defaultSettings} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {AiProvider, buildV2PluginId, ReasoningEffort} from '../build-v2-api.js';
import {readModelDefaults, writeModelDefaults, type ModelDefaults} from './model-defaults.js';

const defaults: ModelDefaults = {
    global: {
        provider: AiProvider.Claude,
        model: '',
        effort: ReasoningEffort.High,
    },
    folders: {
        '/repos/example': {
            provider: AiProvider.Codex,
            model: 'gpt-5',
            effort: undefined,
        },
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

    it('falls back to no defaults when the stored value is malformed', () => {
        assert.deepEquals(
            readModelDefaults({
                pluginSettings: {
                    [`${buildV2PluginId}:model-defaults`]: {
                        global: 'claude',
                    },
                },
            }),
            {
                global: undefined,
                folders: {},
            },
        );
    });
});
