import {check} from '@augment-vir/assert';
import {getObjectTypedEntries, typedObjectFromEntries} from '@augment-vir/common';
import {assertWrapValidShape, defineShape, enumShape} from 'object-shape-tester';
import {AiProvider} from '../build-api.js';

const pluginLaunchShape = defineShape({
    /** The plugin that started the thread, which gives its provider's API key. */
    pluginId: '',
    /** What in that plugin the thread belongs to, such as a bot's id. */
    ownerId: '',
    /** The provider the thread started on, which the owner's API key is for. */
    provider: enumShape(AiProvider),
    /** Declines every request the thread makes, since nobody is there to answer it. */
    isUnattended: false,
    env: [
        {
            name: '',
            value: '',
        },
    ],
});

/** How a plugin started a thread, as a thread's `pluginLaunch` column holds it. */
export type PluginLaunch = Readonly<
    Omit<typeof pluginLaunchShape.runtimeType, 'env'> & {
        /** Set on the thread's provider over the folder's own variables. */
        env: Readonly<Record<string, string>>;
    }
>;

export function serializePluginLaunch(launch: PluginLaunch) {
    return JSON.stringify({
        ...launch,
        env: getObjectTypedEntries(launch.env).map(
            ([
                name,
                value,
            ]) => {
                return {
                    name,
                    value,
                };
            },
        ),
    } satisfies typeof pluginLaunchShape.runtimeType);
}

/** Throws on a value that isn't a launch, so a thread never starts without its owner's key. */
export function parsePluginLaunch(json: string) {
    const parsed: unknown = JSON.parse(json);
    const launch = assertWrapValidShape(
        /** A launch saved without `isUnattended` is attended. */
        check.isObject(parsed)
            ? {
                  isUnattended: false,
                  ...parsed,
              }
            : parsed,
        pluginLaunchShape,
    );
    return {
        ...launch,
        env: typedObjectFromEntries(
            launch.env.map(({name, value}) => {
                return [
                    name,
                    value,
                ] as const;
            }),
        ),
    };
}
