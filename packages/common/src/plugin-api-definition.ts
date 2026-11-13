import {type Shape} from 'object-shape-tester';

/** One request a plugin's browser part makes of its server part. */
export type PluginCallDefinition = Readonly<{
    requestShape: Shape;
    responseShape: Shape;
}>;

/** Every call and event between a plugin's browser part and its server part. */
export type PluginApiDefinition<
    Calls extends Readonly<Record<string, PluginCallDefinition>> = Readonly<
        Record<string, PluginCallDefinition>
    >,
    Events extends Readonly<Record<string, Shape>> = Readonly<Record<string, Shape>>,
> = Readonly<{
    /** The id of the plugin whose server part answers the calls and sends the events. */
    pluginId: string;
    calls: Calls;
    /** Data the server part pushes to every open window, each validated by its shape. */
    events: Events;
}>;

/**
 * Types a plugin's API, which its browser part calls through `createPluginApiClient` and its server
 * part answers through `definePluginServer`. Both sides validate what crosses with the shapes.
 */
export function definePluginApi<
    const Calls extends Readonly<Record<string, PluginCallDefinition>>,
    const Events extends Readonly<Record<string, Shape>> = Readonly<Record<string, never>>,
>(
    definition: Readonly<{
        pluginId: string;
        calls: Calls;
        events?: Events | undefined;
    }>,
): PluginApiDefinition<Calls, Events> {
    return {
        ...definition,
        events: definition.events || ({} satisfies Readonly<Record<string, never>> as Events),
    };
}

/** Any plugin API, as the generic host and client code hold them. */
export type AnyPluginApiDefinition = PluginApiDefinition<any, any>;

/** What `Api`'s call `Call` sends. */
export type PluginCallRequest<
    Api extends AnyPluginApiDefinition,
    Call extends keyof Api['calls'],
> = Api['calls'][Call]['requestShape']['runtimeType'];

/** What `Api`'s call `Call` answers. */
export type PluginCallResponse<
    Api extends AnyPluginApiDefinition,
    Call extends keyof Api['calls'],
> = Api['calls'][Call]['responseShape']['runtimeType'];

/** What `Api`'s event `Event` carries. */
export type PluginEventData<
    Api extends AnyPluginApiDefinition,
    Event extends keyof Api['events'],
> = Api['events'][Event]['runtimeType'];
