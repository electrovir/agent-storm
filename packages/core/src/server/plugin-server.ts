import {
    type AnyPluginApiDefinition,
    type PluginCallRequest,
    type PluginCallResponse,
    type PluginEventData,
    type PluginServerExportsKey,
} from '@agent-storm/common';
import {type MaybePromise} from '@augment-vir/common';
import {type PluginFolderHooks, type PluginServerHost} from './plugin-server-host.js';

/** What the app hands a plugin's server part when it starts it. */
export type PluginServerContext<Api extends AnyPluginApiDefinition> = Readonly<{
    /** Sends `data` to every open window. The app checks it against the event's shape first. */
    emit<const Event extends keyof Api['events'] & string>(
        event: Event,
        data: PluginEventData<Api, Event>,
    ): void;
    /** A folder only this plugin writes in, kept across restarts. Exists before `start` runs. */
    dataDir: string;
    /** A folder only this plugin writes in, which the OS may clear. Exists before `start` runs. */
    tempDir: string;
    /** The app's own state and machinery. */
    host: PluginServerHost;
    /**
     * Waits for a plugin in the manifest's `dependencies` or `optionalDependencies` to finish
     * starting, or restarting, then gives the `exports` its server part returned. Undefined when it
     * isn't running, such as while it's turned off or after its start failed. A dependency's
     * restart doesn't restart this plugin, so call this each time instead of keeping the result.
     */
    waitForPlugin<const Exports>(
        key: PluginServerExportsKey<Exports>,
    ): Promise<Exports | undefined>;
}>;

/** Answers each of `Api`'s calls. Requests and responses are checked against their shapes. */
export type PluginCallHandlers<Api extends AnyPluginApiDefinition> = {
    [Call in keyof Api['calls']]: (
        request: PluginCallRequest<Api, Call>,
    ) => MaybePromise<PluginCallResponse<Api, Call>>;
};

/** A started server part. */
export type RunningPluginServer<Api extends AnyPluginApiDefinition> = Readonly<{
    calls: PluginCallHandlers<Api>;
    folderHooks?: PluginFolderHooks | undefined;
    /**
     * What the plugins that depend on this one get from `waitForPlugin`. Type it with `satisfies`
     * against the type its {@link PluginServerExportsKey} carries.
     */
    exports?: unknown;
    /** Runs when the plugin is turned off or its files change, before a new copy starts. */
    stop?: (() => MaybePromise<void>) | undefined;
}>;

/** A plugin's server part: what its `serverEntry` module exports as its default. */
export type PluginServerDefinition<Api extends AnyPluginApiDefinition> = Readonly<{
    api: Api;
    /**
     * Runs once the plugin is turned on and its dependencies run. Never runs for a blocked or
     * disabled plugin.
     */
    start(context: PluginServerContext<Api>): MaybePromise<RunningPluginServer<Api>>;
}>;

/** Any plugin's server part, as the app holds them. */
export type AnyPluginServerDefinition = PluginServerDefinition<any>;

/** Types a plugin's server part against the API its browser part calls. */
export function definePluginServer<const Api extends AnyPluginApiDefinition>(
    definition: PluginServerDefinition<Api>,
) {
    return definition;
}
