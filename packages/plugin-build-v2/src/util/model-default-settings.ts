import {type Settings} from '@agent-storm/common';
import {
    checkValidShape,
    defineShape,
    enumShape,
    nullableShape,
    recordShape,
} from 'object-shape-tester';
import {AiProvider, buildV2PluginId, ReasoningEffort} from '../build-v2-api.js';

/** The model and effort a new AI chat starts with. */
export const modelDefaultShape = defineShape({
    provider: enumShape(AiProvider),
    /** Empty for the provider's default model. */
    model: '',
    /** Unset for the model's default effort. */
    effort: nullableShape(enumShape(ReasoningEffort)),
});

export type ModelDefault = typeof modelDefaultShape.runtimeType;

const modelDefaultsShape = defineShape({
    global: nullableShape(modelDefaultShape),
    /** Keyed by repo path. A worktree uses its repo's. */
    folders: recordShape({
        keys: '',
        values: modelDefaultShape,
        partial: true,
    }),
});

export type ModelDefaults = typeof modelDefaultsShape.runtimeType;

/**
 * Not inside the plugin's own `pluginSettings` entry: `writePluginSetting` rebuilds that entry from
 * the plugin's declared fields, so it would drop this.
 */
const modelDefaultsKey = `${buildV2PluginId}:model-defaults`;

export function readModelDefaults(
    settings: Readonly<Pick<Settings, 'pluginSettings'>> | undefined,
): ModelDefaults {
    const stored: unknown = settings?.pluginSettings?.[modelDefaultsKey];
    return checkValidShape(stored, modelDefaultsShape)
        ? stored
        : {
              global: undefined,
              folders: {},
          };
}

export function writeModelDefaults({
    settings,
    defaults,
}: Readonly<{
    settings: Readonly<Settings>;
    defaults: Readonly<ModelDefaults>;
}>): Settings {
    return {
        ...settings,
        pluginSettings: {
            ...settings.pluginSettings,
            [modelDefaultsKey]: defaults,
        },
    };
}
