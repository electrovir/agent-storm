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
    serverHash: string;
    /** Its manifest's `dependencies` and `optionalDependencies`, which stop only after it. */
    dependencies: ReadonlyArray<string>;
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
    /** Plugins whose server part stopped, until the sync stopping them starts their new copy. */
    stoppedIds: ReadonlyArray<string>;
    sendEvent:
        | ((message: WebSocketHostMessageType<typeof pluginEventsWebSocket>) => void)
        | undefined;
} = {
    starts: {},
    sync: Promise.resolve(),
    stoppedIds: [],
    sendEvent: undefined,
};

async function importPluginServer({
    pluginId,
    serverPath,
    serverHash,
}: Readonly<{
    pluginId: string;
    serverPath: string;
    serverHash: string;
}>) {
    /** Node keeps every module it imported, so a new hash is the only way to load new code. */
    const module: unknown = await import(
        `${pathToFileURL(serverPath).href}?serverHash=${serverHash}`
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

/**
 * Whether `pluginId` reaches `targetId` through the dependencies of the started plugins. The return
 * type is annotated because the recursion keeps TypeScript from inferring it.
 */
function dependsOn({
    pluginId,
    targetId,
    visited,
}: Readonly<{
    pluginId: string;
    targetId: string;
    visited: ReadonlyArray<string>;
}>): boolean {
    const dependencies = pluginServers.starts[pluginId]?.dependencies || [];
    return dependencies.some((dependencyId) => {
        return (
            dependencyId === targetId ||
            (!visited.includes(dependencyId) &&
                dependsOn({
                    pluginId: dependencyId,
                    targetId,
                    visited: [
                        ...visited,
                        dependencyId,
                    ],
                }))
        );
    });
}

type ActivePluginServer = Awaited<ReturnType<typeof readActivePluginServers>>[number];

async function readStartedExports(pluginId: string) {
    const start = pluginServers.starts[pluginId];
    return start && !pluginServers.stoppedIds.includes(pluginId)
        ? (await start.running).server?.exports
        : undefined;
}

/**
 * The dependency's `exports`, once it finishes starting or a queued sync finishes restarting it.
 * Undefined when it isn't running and no queued sync starts it. The return type is annotated
 * because the recursion keeps TypeScript from inferring it.
 */
async function waitForPluginExports({
    pluginId,
    dependencyId,
}: Readonly<{
    pluginId: string;
    dependencyId: string;
}>): Promise<unknown> {
    /** Each waits for the other to start, so neither ever would. */
    if (
        dependsOn({
            pluginId: dependencyId,
            targetId: pluginId,
            visited: [],
        })
    ) {
        throw new Error(`Plugins '${pluginId}' and '${dependencyId}' depend on each other.`);
    } else if (
        pluginServers.starts[dependencyId] &&
        !pluginServers.stoppedIds.includes(dependencyId)
    ) {
        return await readStartedExports(dependencyId);
    }
    const sync = pluginServers.sync;
    await sync;
    return pluginServers.sync === sync
        ? await readStartedExports(dependencyId)
        : await waitForPluginExports({
              pluginId,
              dependencyId,
          });
}

function startPluginServer(plugin: ActivePluginServer): PluginServerStart {
    return {
        serverHash: plugin.serverHash,
        dependencies: [
            ...plugin.dependencies,
            ...plugin.optionalDependencies,
        ],
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
                    async waitForPlugin(key) {
                        if (
                            !plugin.dependencies.includes(key.pluginId) &&
                            !plugin.optionalDependencies.includes(key.pluginId)
                        ) {
                            throw new Error(
                                `Plugin '${plugin.pluginId}' waited for plugin '${key.pluginId}', which its manifest's dependencies and optionalDependencies don't list.`,
                            );
                        }
                        /**
                         * The dependency's `exports` are typed only by its key, which its server
                         * part's `satisfies` checks against.
                         */
                        return (await waitForPluginExports({
                            pluginId: plugin.pluginId,
                            dependencyId: key.pluginId,
                        })) satisfies unknown as typeof key.exportsType;
                    },
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
    pluginServers.stoppedIds = [
        ...pluginServers.stoppedIds,
        pluginId,
    ];
    try {
        await (await start.running).server?.stop?.();
    } catch (error) {
        log.error(`Plugin '${pluginId}' server failed to stop: ${extractErrorMessage(error)}`);
    }
}

/**
 * Stops the started plugins with ids in `pluginIds`, each only after every one of them that depends
 * on it, so a plugin's `stop` can still use its dependencies' `exports`.
 */
async function stopPluginServersInOrder(pluginIds: ReadonlyArray<string>) {
    const leaves = pluginIds.filter((pluginId) => {
        return !pluginIds.some((otherId) => {
            return pluginServers.starts[otherId]?.dependencies.includes(pluginId);
        });
    });
    /** Ids left in a dependency cycle stop together. */
    const wave = leaves.length ? leaves : pluginIds;
    await Promise.all(
        wave.map(async (pluginId) => {
            const start = pluginServers.starts[pluginId];
            if (start) {
                await stopPluginServer({
                    pluginId,
                    start,
                });
            }
        }),
    );
    const remaining = pluginIds.filter((pluginId) => !wave.includes(pluginId));
    if (remaining.length) {
        await stopPluginServersInOrder(remaining);
    }
}

/**
 * Stops each server part whose plugin stopped running or whose files changed, then starts each
 * active plugin's that isn't running. A plugin whose dependency restarts keeps running: its
 * `waitForPlugin` calls wait out the restart.
 */
async function syncPluginServers() {
    const active = await readActivePluginServers();
    const staleIds = Object.entries(pluginServers.starts)
        .filter(
            ([
                pluginId,
                start,
            ]) => {
                return !active.some((plugin) => {
                    return plugin.pluginId === pluginId && plugin.serverHash === start.serverHash;
                });
            },
        )
        .map(([pluginId]) => pluginId);
    await stopPluginServersInOrder(staleIds);
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
    pluginServers.stoppedIds = [];
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
    await stopPluginServersInOrder(Object.keys(pluginServers.starts));
    pluginServers.starts = {};
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
