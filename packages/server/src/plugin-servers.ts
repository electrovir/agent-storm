import {type AnyPluginApiDefinition, type pluginEventsWebSocket} from '@agent-storm/common';
import {type AnyPluginServerDefinition, type RunningPluginServer} from '@agent-storm/core/server';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, log, type MaybePromise} from '@augment-vir/common';
import {type WebSocketHostMessageType} from '@rest-vir/api';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertValidShape} from 'object-shape-tester';
import {pluginDataDir, pluginTempDir} from './file-paths.js';
import {setPluginFolderHooks} from './plugin-folder-hooks.js';
import {pluginServerHost} from './plugin-server-host.js';
import {listenToPluginChanges, readActivePluginServers} from './plugins.js';

/** One plugin's started server part, or why it didn't start. */
type PluginServerStart = Readonly<{
    contentHash: string;
    running: Promise<
        Readonly<
            | {
                  api: AnyPluginApiDefinition;
                  server: RunningPluginServer<AnyPluginApiDefinition>;
                  problem?: undefined;
              }
            | {
                  api?: undefined;
                  server?: undefined;
                  problem: string;
              }
        >
    >;
}>;

const pluginServers: {
    starts: Readonly<Record<string, PluginServerStart>>;
    /** Runs one sync at a time, so a plugin is never started twice. */
    sync: Promise<void>;
    sendEvent:
        | ((message: WebSocketHostMessageType<typeof pluginEventsWebSocket>) => void)
        | undefined;
} = {
    starts: {},
    sync: Promise.resolve(),
    sendEvent: undefined,
};

async function importPluginServer({
    pluginId,
    serverPath,
    contentHash,
}: Readonly<{
    pluginId: string;
    serverPath: string;
    contentHash: string;
}>) {
    /** Node keeps every module it imported, so a new hash is the only way to load new code. */
    const module: unknown = await import(
        `${pathToFileURL(serverPath).href}?contentHash=${contentHash}`
    );
    const definition =
        check.isObject(module) && check.hasKey(module, 'default') ? module.default : undefined;
    if (
        !check.isObject(definition) ||
        !check.hasKey(definition, 'api') ||
        !check.hasKey(definition, 'start') ||
        !check.isObject(definition.api) ||
        !check.hasKey(definition.api, 'pluginId') ||
        definition.api.pluginId !== pluginId
    ) {
        throw new Error(`Its server entry's default export isn't a server for '${pluginId}'.`);
    }
    return definition satisfies object as AnyPluginServerDefinition;
}

function startPluginServer(
    plugin: Readonly<{
        pluginId: string;
        serverPath: string;
        contentHash: string;
    }>,
): PluginServerStart {
    return {
        contentHash: plugin.contentHash,
        running: (async () => {
            try {
                const definition = await importPluginServer(plugin);
                const dataDir = join(pluginDataDir, plugin.pluginId);
                const tempDir = join(pluginTempDir, plugin.pluginId);
                await Promise.all(
                    [
                        dataDir,
                        tempDir,
                    ].map(async (dir) => {
                        await mkdir(dir, {
                            recursive: true,
                        });
                    }),
                );
                const server = await definition.start({
                    dataDir,
                    tempDir,
                    host: pluginServerHost,
                    emit(event, data) {
                        assertValidShape(data, definition.api.events[event]);
                        pluginServers.sendEvent?.({
                            pluginId: plugin.pluginId,
                            event,
                            data,
                        });
                    },
                });
                setPluginFolderHooks({
                    pluginId: plugin.pluginId,
                    hooks: server.folderHooks,
                });
                return {
                    api: definition.api,
                    server,
                };
            } catch (error) {
                log.error(
                    `Plugin '${plugin.pluginId}' server failed to start: ${extractErrorMessage(error)}`,
                );
                return {
                    problem: extractErrorMessage(error),
                };
            }
        })(),
    };
}

async function stopPluginServer({
    pluginId,
    start,
}: Readonly<{
    pluginId: string;
    start: PluginServerStart;
}>) {
    setPluginFolderHooks({
        pluginId,
        hooks: undefined,
    });
    try {
        await (await start.running).server?.stop?.();
    } catch (error) {
        log.error(`Plugin '${pluginId}' server failed to stop: ${extractErrorMessage(error)}`);
    }
}

/**
 * Stops each server part whose plugin stopped running or whose files changed, then starts each
 * active plugin's that isn't running.
 */
async function syncPluginServers() {
    const active = await readActivePluginServers();
    const stale = Object.entries(pluginServers.starts).filter(
        ([
            pluginId,
            start,
        ]) => {
            return !active.some((plugin) => {
                return plugin.pluginId === pluginId && plugin.contentHash === start.contentHash;
            });
        },
    );
    await Promise.all(
        stale.map(
            async ([
                pluginId,
                start,
            ]) => {
                await stopPluginServer({
                    pluginId,
                    start,
                });
            },
        ),
    );
    const staleIds = stale.map(([pluginId]) => pluginId);
    const kept = Object.entries(pluginServers.starts).filter(
        ([pluginId]) => !staleIds.includes(pluginId),
    );
    pluginServers.starts = Object.fromEntries([
        ...kept,
        ...active
            .filter((plugin) => !kept.some(([pluginId]) => pluginId === plugin.pluginId))
            .map((plugin) => {
                return [
                    plugin.pluginId,
                    startPluginServer(plugin),
                ] as const;
            }),
    ]);
}

function queuePluginServerSync() {
    pluginServers.sync = pluginServers.sync.then(syncPluginServers).catch((error: unknown) => {
        log.error(`Plugin servers failed to sync: ${extractErrorMessage(error)}`);
    });
    return pluginServers.sync;
}

/**
 * Starts every active plugin's server part, and keeps them in step with the plugins from then on.
 * `sendEvent` sends a plugin's event to every open window.
 */
export async function startPluginServers(
    sendEvent: (message: WebSocketHostMessageType<typeof pluginEventsWebSocket>) => void,
) {
    pluginServers.sendEvent = sendEvent;
    listenToPluginChanges(() => {
        void queuePluginServerSync();
    });
    await queuePluginServerSync();
}

/** Stops every plugin's server part, for the app shutting down. */
export async function stopPluginServers() {
    await pluginServers.sync;
    const starts = pluginServers.starts;
    pluginServers.starts = {};
    await Promise.all(
        Object.entries(starts).map(
            async ([
                pluginId,
                start,
            ]) => {
                await stopPluginServer({
                    pluginId,
                    start,
                });
            },
        ),
    );
}

/** Answers one call of a plugin's API, checking the request and the response against its shapes. */
export async function callPluginServer({
    pluginId,
    call,
    request,
}: Readonly<{
    pluginId: string;
    call: string;
    request: unknown;
}>) {
    await pluginServers.sync;
    const start = pluginServers.starts[pluginId];
    const running = start ? await start.running : undefined;
    if (!running?.server) {
        throw new Error(
            [
                `Plugin '${pluginId}' has no running server part`,
                running?.problem ? `: ${running.problem}` : '.',
            ].join(''),
        );
    }
    const callDefinition = running.api.calls[call];
    const handler: ((request: unknown) => MaybePromise<unknown>) | undefined =
        running.server.calls[call];
    if (!callDefinition || !handler) {
        throw new Error(`Plugin '${pluginId}' has no call '${call}'.`);
    }
    assertValidShape(request, callDefinition.requestShape);
    const response = await handler(request);
    assertValidShape(response, callDefinition.responseShape);
    return response;
}
