import {ThreadOrigin, type Settings} from '@agent-storm/common';
import {
    checkValidShape,
    defineShape,
    enumShape,
    nullableShape,
    optionalShape,
    recordShape,
} from 'object-shape-tester';
import {AiProvider, buildPluginId, ReasoningEffort} from '../build-api.js';

/** The model and effort a new AI chat starts with. */
export const modelDefaultShape = defineShape({
    provider: enumShape(AiProvider),
    /** Empty for the provider's default model. */
    model: '',
    /** Unset for the model's default effort. */
    effort: nullableShape(enumShape(ReasoningEffort)),
    /** Unset for standard speed. */
    speedTier: nullableShape(''),
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
    /**
     * Keyed by the origin of a plugin's threads. Overrides the folder and global defaults, and
     * switches that origin's existing threads too.
     */
    origins: optionalShape(
        recordShape({
            keys: enumShape(ThreadOrigin),
            values: modelDefaultShape,
            partial: true,
        }),
        {
            alsoUndefined: true,
        },
    ),
});

export type ModelDefaults = typeof modelDefaultsShape.runtimeType;

/**
 * Not inside the plugin's own `pluginSettings` entry: `writePluginSetting` rebuilds that entry from
 * the plugin's declared fields, so it would drop this.
 */
const modelDefaultsKey = `${buildPluginId}:model-defaults`;

export function readModelDefaults(
    settings: Readonly<Pick<Settings, 'pluginSettings'>> | undefined,
): ModelDefaults {
    const stored: unknown = settings?.pluginSettings?.[modelDefaultsKey];
    return checkValidShape(stored, modelDefaultsShape)
        ? stored
        : {
              global: undefined,
              folders: {},
              origins: undefined,
          };
}

/**
 * The model a new thread of `origin` in `folder` starts with: the origin's default, else the
 * folder's, else the global one, else Claude's default model.
 */
export function resolveThreadModelDefault({
    defaults,
    folder,
    origin,
}: Readonly<{
    defaults: Readonly<ModelDefaults>;
    /** A worktree's repo, since a worktree uses its repo's default. */
    folder: string;
    origin: ThreadOrigin;
}>) {
    return (
        defaults.origins?.[origin] ||
        defaults.folders[folder] ||
        defaults.global || {
            provider: AiProvider.Claude,
            model: '',
            effort: undefined,
            speedTier: undefined,
        }
    );
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
