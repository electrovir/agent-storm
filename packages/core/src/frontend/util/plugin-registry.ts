import {
    pluginCodeEndpoint,
    pluginDecisionEndpoint,
    pluginsEndpoint,
    PluginStatus,
    type PluginActivityContribution,
    type PluginDecision,
    type PluginEntry,
    type PluginManifest,
    type PluginPaneContribution,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    extractErrorMessage,
    getObjectTypedEntries,
    getObjectTypedValues,
    typedObjectFromEntries,
} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {css, html, isObservableBase, listen, Observable} from 'element-vir';
import {
    createSizedIcon,
    LoaderAnimated24Icon,
    LucidePuzzleIcon,
    ViraButton,
    ViraIcon,
    ViraSize,
    type ViraIconSvg,
} from 'vira';
import {fetchApi} from './api-client.js';
import {
    defineActivity,
    noTabStateShape,
    PaneMounting,
    SettingsSection,
    type AnyActivityDefinition,
    type AnyPaneDefinition,
    type AppServices,
    type PaneDefinition,
    type PluginDefinition,
} from './plugin-api.js';
import {createPluginSettingsSection} from './plugin-settings-section.js';
import {
    pluginModulesSymbolName,
    SharedModuleName,
    sharedModulesSymbolName,
} from './shared-module-names.js';

export type PluginRegistryObservable = ReturnType<typeof createPluginRegistry>;

type PluginsResponse = Awaited<ReturnType<typeof fetchPlugins>>;

/** What a plugin adds to the app, merged across every running plugin. */
export type PluginContributions = Readonly<{
    [Key in 'activities' | 'panes' | 'paneGroupExtensions' | 'settingsSections']-?: NonNullable<
        PluginDefinition[Key]
    >;
}>;

async function fetchPlugins() {
    return await fetchApi(pluginsEndpoint, HttpMethod.Get);
}

const sharedModuleImports: Readonly<Record<SharedModuleName, () => Promise<unknown>>> = {
    async [SharedModuleName.ElementVir]() {
        return await import('element-vir');
    },
    async [SharedModuleName.Vira]() {
        return await import('vira');
    },
    async [SharedModuleName.Common]() {
        return await import('@agent-storm/common');
    },
    async [SharedModuleName.CoreFrontend]() {
        return await import('../index.js');
    },
};

const sharedModulesExposure: {
    promise: Promise<void> | undefined;
} = {
    promise: undefined,
};

/**
 * Hands the app's own copy of each shared package to plugins. Run only once one loads, since it
 * pulls in all of vira, icons included.
 */
async function exposeSharedModules() {
    sharedModulesExposure.promise ||= Promise.all(
        getObjectTypedValues(SharedModuleName).map(async (name) => {
            return [
                name,
                await sharedModuleImports[name](),
            ] as const;
        }),
    ).then((entries) => {
        Reflect.set(
            globalThis,
            Symbol.for(sharedModulesSymbolName),
            typedObjectFromEntries(entries),
        );
    });
    await sharedModulesExposure.promise;
}

function listIds(entries: ReadonlyArray<Readonly<{id: string}>> | undefined) {
    return (entries || []).map((entry) => entry.id).toSorted();
}

function listActivities(
    activities:
        | ReadonlyArray<Readonly<Pick<PluginActivityContribution, 'id' | 'isEnabledByDefault'>>>
        | undefined,
) {
    return (activities || [])
        .map((activity) => `${activity.id}:${activity.isEnabledByDefault}`)
        .toSorted();
}

/**
 * The plugin a loaded module's default export defines, once it's checked against the manifest the
 * user approved, so a plugin can't add anything its manifest didn't list.
 */
function readPluginModule({
    module,
    manifest,
}: Readonly<{
    module: unknown;
    manifest: Readonly<PluginManifest>;
}>) {
    const definition =
        check.isObject(module) && check.hasKey(module, 'default') ? module.default : undefined;
    if (
        !check.isObject(definition) ||
        !check.hasKey(definition, 'id') ||
        definition.id !== manifest.id
    ) {
        throw new Error(`Its default export isn't a plugin with id '${manifest.id}'.`);
    }
    const plugin = definition satisfies object as PluginDefinition;
    const mismatches = [
        check.jsonEquals(listActivities(plugin.activities), listActivities(manifest.activities))
            ? ''
            : 'activities',
        check.jsonEquals(listIds(plugin.panes), listIds(manifest.panes)) ? '' : 'panes',
    ].filter(check.isTruthy);
    if (mismatches.length) {
        throw new Error(`Its ${mismatches.join(' and ')} don't match the ones its manifest lists.`);
    }
    return plugin;
}

const pluginCodeCacheName = 'agent-storm-plugin-code';

function createPluginCodeCacheKey({
    pluginId,
    contentHash,
}: Readonly<{
    pluginId: string;
    contentHash: string;
}>) {
    return `/plugin-code/${encodeURIComponent(pluginId)}/${contentHash}`;
}

/** Undefined where the page can't use the Cache API, such as an insecure origin. */
async function openPluginCodeCache() {
    try {
        return 'caches' in globalThis ? await caches.open(pluginCodeCacheName) : undefined;
    } catch {
        return undefined;
    }
}

/** Replaces every code the cache holds for the plugin with `code`. */
async function storePluginCode({
    cache,
    pluginId,
    contentHash,
    code,
}: Readonly<{
    cache: Cache;
    pluginId: string;
    contentHash: string;
    code: string;
}>) {
    const pluginPrefix = createPluginCodeCacheKey({
        pluginId,
        contentHash: '',
    });
    const staleKeys = (await cache.keys()).filter((request) => {
        return request.url.includes(pluginPrefix);
    });
    await Promise.all(staleKeys.map(async (key) => await cache.delete(key)));
    await cache.put(
        createPluginCodeCacheKey({
            pluginId,
            contentHash,
        }),
        new Response(code),
    );
}

/**
 * A plugin's browser entry, kept in the browser by content hash so a page load only downloads the
 * plugins whose code changed. The bundles run to megabytes, which a phone otherwise downloads on
 * every load. The server only lists a hash it serves as approved, so cached code is that code.
 */
async function readPluginCode(plugin: Readonly<PluginEntry>) {
    const cache = await openPluginCodeCache();
    const cachedResponse = await cache
        ?.match(
            createPluginCodeCacheKey({
                pluginId: plugin.id,
                contentHash: plugin.contentHash,
            }),
        )
        .catch(() => undefined);
    if (cachedResponse) {
        return await cachedResponse.text();
    }
    const {code, contentHash} = await fetchApi(pluginCodeEndpoint, HttpMethod.Post, {
        requestData: {
            pluginId: plugin.id,
        },
    });
    if (cache) {
        await storePluginCode({
            cache,
            pluginId: plugin.id,
            contentHash,
            code,
        }).catch(() => undefined);
    }
    return code;
}

/** Imports a plugin's browser entry, then shares its module with the plugins that depend on it. */
async function importPlugin(plugin: Readonly<PluginEntry>) {
    const manifest = plugin.manifest;
    if (!manifest) {
        throw new Error(`Plugin '${plugin.id}' has no manifest.`);
    }
    const [
        ,
        code,
    ] = await Promise.all([
        exposeSharedModules(),
        readPluginCode(plugin),
    ]);
    const url = URL.createObjectURL(
        new Blob(
            [
                code,
            ],
            {
                type: 'text/javascript',
            },
        ),
    );
    try {
        const module: unknown = await import(/* @vite-ignore */ url);
        const definition = readPluginModule({
            module,
            manifest,
        });
        Reflect.set(globalThis, Symbol.for(pluginModulesSymbolName), {
            ...Reflect.get(globalThis, Symbol.for(pluginModulesSymbolName)),
            [plugin.id]: module,
        });
        return definition;
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** Stands in for a pending plugin's activity, so its name shows and its URL still resolves. */
function createPendingActivity({
    plugin,
    contribution,
}: Readonly<{
    plugin: Readonly<PluginEntry>;
    contribution: Readonly<PluginActivityContribution>;
}>) {
    return defineActivity({
        id: contribution.id,
        label: contribution.label,
        isEnabledByDefault: true,
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render({context}) {
            return html`
                <div
                    style=${css`
                        display: flex;
                        flex-direction: column;
                        align-items: flex-start;
                        gap: 12px;
                        padding: 24px;
                    `}
                >
                    <span>
                        ${contribution.label} comes from the plugin
                        ${plugin.manifest?.name || plugin.id}, which hasn't been approved to run.
                    </span>
                    <${ViraButton.assign({
                        text: 'Review plugins',
                        buttonSize: ViraSize.Small,
                    })}
                        ${listen('click', () => {
                            context.openSettings({
                                section: SettingsSection.Plugins,
                            });
                        })}
                    ></${ViraButton}>
                </div>
            `;
        },
    });
}

function renderLoader() {
    return html`
        <div
            style=${css`
                display: flex;
                justify-content: center;
                padding: 24px;
            `}
        >
            <${ViraIcon.assign({
                icon: LoaderAnimated24Icon,
            })}></${ViraIcon}>
        </div>
    `;
}

/** Stands in for an approved plugin's activity until it's shown, which loads the plugin. */
function createLazyActivity({
    contribution,
    load,
}: Readonly<{
    contribution: Readonly<PluginActivityContribution>;
    load: () => void;
}>) {
    return defineActivity({
        id: contribution.id,
        label: contribution.label,
        isEnabledByDefault: contribution.isEnabledByDefault,
        mobileMenuTitle: undefined,
        sidebar: undefined,
        isKeptMounted: false,
        render() {
            load();
            return renderLoader();
        },
    });
}

/** Stands in for an approved plugin's pane until one of its tabs is shown, which loads the plugin. */
function createLazyPane({
    contribution,
    viraModule,
    load,
}: Readonly<{
    contribution: Readonly<PluginPaneContribution>;
    /** Vira's module, holding the icon the manifest names. */
    viraModule: unknown;
    load: () => void;
}>) {
    const icon: unknown =
        contribution.icon && check.isObject(viraModule)
            ? Reflect.get(viraModule, contribution.icon)
            : undefined;
    return {
        id: contribution.id,
        tabStateShape: noTabStateShape,
        label() {
            return contribution.label;
        },
        newTabEntries() {
            return [
                {
                    label: contribution.label,
                    state: undefined,
                },
            ];
        },
        icon: createSizedIcon(
            check.isObject(icon) && check.hasKey(icon, 'svgTemplate')
                ? (icon satisfies object as ViraIconSvg)
                : LucidePuzzleIcon,
            14,
        ),
        hasAi: false,
        mounting: PaneMounting.WhileDisplayed,
        isAvailable() {
            return true;
        },
        render() {
            load();
            return renderLoader();
        },
    } satisfies PaneDefinition;
}

/** `pluginIds` and every plugin they depend on, directly or not. Annotated because it recurses. */
function addDependencies({
    pluginIds,
    plugins,
}: Readonly<{
    pluginIds: ReadonlyArray<string>;
    plugins: ReadonlyArray<PluginEntry>;
}>): ReadonlyArray<string> {
    const dependencyIds = plugins
        .filter((plugin) => pluginIds.includes(plugin.id))
        .flatMap((plugin) => plugin.manifest?.dependencies || [])
        .filter((dependencyId) => !pluginIds.includes(dependencyId));
    return dependencyIds.length
        ? addDependencies({
              pluginIds: [
                  ...pluginIds,
                  ...dependencyIds,
              ],
              plugins,
          })
        : pluginIds;
}

function dropRepeatedIds<const Entry extends Readonly<{id: string}>>(
    entries: ReadonlyArray<Entry>,
) {
    return entries.filter((entry, index) => {
        return entries.findIndex((other) => other.id === entry.id) === index;
    });
}

const isStatusPending: Readonly<Record<PluginStatus, boolean>> = {
    [PluginStatus.Active]: false,
    [PluginStatus.NeedsApproval]: true,
    [PluginStatus.Disabled]: false,
    [PluginStatus.Changed]: true,
    [PluginStatus.Blocked]: false,
    [PluginStatus.Invalid]: false,
    [PluginStatus.IncompatibleCore]: false,
    [PluginStatus.MissingDependency]: false,
};

/** Whether a plugin waits on the user's approval, so its panes and activities show disabled. */
export function isPluginPending(plugin: Readonly<Pick<PluginEntry, 'status' | 'manifest'>>) {
    return !!plugin.manifest && isStatusPending[plugin.status];
}

/** One plugin's load: its code's hash, and what it defined or why it failed. */
type PluginLoad = Readonly<{
    contentHash: string;
    result: Promise<
        Readonly<
            | {
                  definition: PluginDefinition;
                  problem?: undefined;
              }
            | {
                  definition?: undefined;
                  problem: string;
              }
        >
    >;
}>;

/**
 * Every plugin the app runs, built-in or external: each one the server says is active, imported
 * from the server only once something requests it and only after the plugins it depends on. Until
 * then its activities and panes are stand-ins built from its manifest, which request it once shown.
 * External plugins waiting on approval add stand-ins too, which link to the Plugins settings.
 * Reloads whenever the server's plugins revision, polled with the folder list, changes.
 */
export function createPluginRegistry({
    hostPanes,
    services,
    navigate,
}: Readonly<{
    /** Panes the app itself adds, listed after every plugin's. */
    hostPanes: ReadonlyArray<AnyPaneDefinition>;
    services: AppServices;
    /** Selects `paths` in the window's URL. */
    navigate(paths: ReadonlyArray<string>): void;
}>) {
    const observable = new Observable<
        Readonly<{
            /** Undefined until the server first answers. */
            response: Readonly<PluginsResponse> | undefined;
            /** True until the server first answers. */
            isLoading: boolean;
            runningPlugins: ReadonlyArray<PluginDefinition>;
            pendingPlugins: ReadonlyArray<PluginEntry>;
            /** The stand-in activities among `contributions.activities`. */
            pendingActivityIds: ReadonlyArray<string>;
            /** The panes of pending plugins, which the new-tab menu lists disabled. */
            pendingPanes: ReadonlyArray<PluginPaneContribution>;
            /** The activities and panes standing in for plugins that haven't been requested. */
            unloadedIds: ReadonlyArray<string>;
            contributions: PluginContributions;
            /** Why an active plugin isn't running, by plugin id. */
            problems: Readonly<Record<string, string>>;
            /**
             * Plugins approved again with new code after their old code already ran. Custom
             * elements can't be redefined, so the new code runs from the window's next load.
             */
            outdatedPluginIds: ReadonlyArray<string>;
            /** Each activity's state, keyed by activity id. */
            activityStates: Readonly<Record<string, unknown>>;
            /** Changes whenever an observable in an activity's state does, to re-render the app. */
            activityStateChangeCount: number;
        }>
    >({
        /** The default deep check walks into pane shapes, whose symbol keys make it throw. */
        equalityCheck: undefined,
        defaultValue: {
            response: undefined,
            isLoading: true,
            runningPlugins: [],
            pendingPlugins: [],
            pendingActivityIds: [],
            pendingPanes: [],
            unloadedIds: [],
            contributions: {
                activities: [],
                panes: hostPanes,
                paneGroupExtensions: [],
                settingsSections: [],
            },
            problems: {},
            outdatedPluginIds: [],
            activityStates: {},
            activityStateChangeCount: 0,
        },
    });
    const destroyObservable = observable.destroy.bind(observable);
    const tracking: {
        fetchedRevision: string | undefined;
        /** The latest response applied, to apply again when a plugin is requested. */
        response: Readonly<PluginsResponse> | undefined;
        /** Drops a response a newer one overtook while its plugins loaded. */
        applyCount: number;
        requestedPluginIds: ReadonlyArray<string>;
        isAllRequested: boolean;
        loads: Readonly<Record<string, PluginLoad>>;
        /** Each running plugin's `startWithApp` removers, by plugin id. */
        stops: Readonly<Record<string, ReadonlyArray<() => void>>>;
        /** Created once per window, so blocking and unblocking a plugin keeps its state. */
        activityStates: Readonly<Record<string, unknown>>;
        stateListenerRemovers: ReadonlyArray<() => void>;
    } = {
        fetchedRevision: undefined,
        response: undefined,
        applyCount: 0,
        requestedPluginIds: [],
        isAllRequested: false,
        loads: {},
        stops: {},
        activityStates: {},
        stateListenerRemovers: [],
    };

    /**
     * Loads `plugin` once each plugin it depends on has loaded. `dependents` holds the plugins
     * waiting on this load, to fail a dependency cycle instead of waiting on it forever.
     */
    function loadPlugin({
        plugin,
        activePlugins,
        dependents,
    }: Readonly<{
        plugin: Readonly<PluginEntry>;
        activePlugins: ReadonlyArray<PluginEntry>;
        dependents: ReadonlyArray<string>;
    }>): PluginLoad {
        const existing = tracking.loads[plugin.id];
        /** A failed load is retried with the new code. A loaded one keeps running its old code. */
        const isRetry = existing && existing.contentHash !== plugin.contentHash;
        if (existing && !isRetry) {
            return existing;
        }
        const load: PluginLoad = {
            contentHash: plugin.contentHash,
            result: (existing?.result || Promise.resolve(undefined)).then(async (previous) => {
                if (previous?.definition) {
                    return previous;
                }
                const dependencyProblems = await Promise.all(
                    (plugin.manifest?.dependencies || []).map(async (dependencyId) => {
                        const dependency = activePlugins.find((entry) => {
                            return entry.id === dependencyId;
                        });
                        if (dependents.includes(dependencyId)) {
                            return `It and '${dependencyId}' depend on each other.`;
                        } else if (!dependency) {
                            return `The plugin it depends on, '${dependencyId}', isn't running.`;
                        }
                        const result = await loadPlugin({
                            plugin: dependency,
                            activePlugins,
                            dependents: [
                                ...dependents,
                                plugin.id,
                            ],
                        }).result;
                        return result.problem
                            ? `The plugin it depends on, '${dependencyId}', failed to load.`
                            : '';
                    }),
                );
                const dependencyProblem = dependencyProblems.find(check.isTruthy);
                if (dependencyProblem) {
                    return {
                        problem: dependencyProblem,
                    };
                }
                try {
                    return {
                        definition: await importPlugin(plugin),
                    };
                } catch (error) {
                    return {
                        problem: extractErrorMessage(error),
                    };
                }
            }),
        };
        tracking.loads = {
            ...tracking.loads,
            [plugin.id]: load,
        };
        return load;
    }

    function ensureActivityStates(activities: ReadonlyArray<AnyActivityDefinition>) {
        const created = activities
            .filter((activity) => !Object.hasOwn(tracking.activityStates, activity.id))
            .map((activity) => {
                return [
                    activity.id,
                    activity.createState?.(),
                ] as const;
            });
        tracking.activityStates = {
            ...tracking.activityStates,
            ...typedObjectFromEntries(created),
        };
        tracking.stateListenerRemovers = [
            ...tracking.stateListenerRemovers,
            ...created.flatMap(
                ([
                    ,
                    state,
                ]) => {
                    return check.isObject(state)
                        ? getObjectTypedValues(state)
                              .filter(isObservableBase)
                              .map((stateObservable) => {
                                  return stateObservable.listen(false, () => {
                                      observable.setValue({
                                          ...observable.value,
                                          activityStateChangeCount:
                                              observable.value.activityStateChangeCount + 1,
                                      });
                                  });
                              })
                        : [];
                },
            ),
        ];
    }

    /** Starts each newly running plugin's app-long work and stops each stopped plugin's. */
    function syncStarted(runningPlugins: ReadonlyArray<PluginDefinition>) {
        const runningIds = runningPlugins.map((plugin) => plugin.id);
        getObjectTypedEntries(tracking.stops)
            .filter(([pluginId]) => !runningIds.includes(pluginId))
            .forEach(
                ([
                    ,
                    stops,
                ]) => stops.forEach((stop) => stop()),
            );
        tracking.stops = typedObjectFromEntries(
            runningPlugins.map((plugin) => {
                return [
                    plugin.id,
                    tracking.stops[plugin.id] ||
                        (plugin.activities || []).flatMap((activity) => {
                            return (
                                activity.startWithApp?.({
                                    services,
                                    state: tracking.activityStates[activity.id],
                                    navigate(subPaths) {
                                        navigate([
                                            activity.id,
                                            ...subPaths,
                                        ]);
                                    },
                                }) || []
                            );
                        }),
                ] as const;
            }),
        );
    }

    /**
     * The plugins that run, in order, leaving out each one that reuses an id an earlier plugin
     * already has.
     */
    function dropCollisions(candidates: ReadonlyArray<PluginDefinition>) {
        return candidates.reduce<{
            plugins: ReadonlyArray<PluginDefinition>;
            problems: Readonly<Record<string, string>>;
        }>(
            (accumulated, plugin) => {
                const takenIds = accumulated.plugins.flatMap((running) => {
                    return [
                        running.id,
                        ...(running.activities || []).map((activity) => activity.id),
                        ...(running.panes || []).map((pane) => pane.id),
                        ...hostPanes.map((pane) => pane.id),
                    ];
                });
                const collision = [
                    plugin.id,
                    ...(plugin.activities || []).map((activity) => activity.id),
                    ...(plugin.panes || []).map((pane) => pane.id),
                ].find((id) => takenIds.includes(id));
                return collision
                    ? {
                          ...accumulated,
                          problems: {
                              ...accumulated.problems,
                              [plugin.id]: `Another plugin already uses the id '${collision}'.`,
                          },
                      }
                    : {
                          ...accumulated,
                          plugins: [
                              ...accumulated.plugins,
                              plugin,
                          ],
                      };
            },
            {
                plugins: [],
                problems: {},
            },
        );
    }

    async function applyResponse(response: Readonly<PluginsResponse> | undefined) {
        const applyCount = ++tracking.applyCount;
        tracking.response = response;
        const activePlugins = (response?.plugins || []).filter((plugin) => {
            return plugin.status === PluginStatus.Active;
        });
        const requestedIds = addDependencies({
            pluginIds: tracking.isAllRequested
                ? activePlugins.map((plugin) => plugin.id)
                : tracking.requestedPluginIds,
            plugins: activePlugins,
        });
        const lazyPlugins = activePlugins.filter((plugin) => !requestedIds.includes(plugin.id));
        const [
            loaded,
            viraModule,
        ] = await Promise.all([
            Promise.all(
                activePlugins
                    .filter((plugin) => requestedIds.includes(plugin.id))
                    .map(async (plugin) => {
                        const load = loadPlugin({
                            plugin,
                            activePlugins,
                            dependents: [],
                        });
                        return {
                            plugin,
                            isOutdated: load.contentHash !== plugin.contentHash,
                            ...(await load.result),
                        };
                    }),
            ),
            lazyPlugins.some((plugin) => plugin.manifest?.panes.length)
                ? sharedModuleImports[SharedModuleName.Vira]()
                : undefined,
        ]);
        if (applyCount !== tracking.applyCount) {
            return;
        }
        const pendingPlugins = (response?.plugins || []).filter(isPluginPending);
        const {plugins: runningPlugins, problems: collisionProblems} = dropCollisions(
            loaded.map((entry) => entry.definition).filter(check.isTruthy),
        );
        const byPlugin = activePlugins.map((plugin) => {
            const running = runningPlugins.find((entry) => entry.id === plugin.id);
            const lazyManifest = lazyPlugins.includes(plugin) ? plugin.manifest : undefined;
            function load() {
                requestPlugins([
                    plugin.id,
                ]);
            }
            const lazyActivities = (lazyManifest?.activities || []).map((contribution) => {
                return createLazyActivity({
                    contribution,
                    load,
                });
            });
            const lazyPanes = (lazyManifest?.panes || []).map((contribution) => {
                return createLazyPane({
                    contribution,
                    viraModule,
                    load,
                });
            });
            return {
                activities: [
                    ...(running?.activities || []),
                    ...lazyActivities,
                ],
                panes: [
                    ...(running?.panes || []),
                    ...lazyPanes,
                ],
                lazy: [
                    ...lazyActivities,
                    ...lazyPanes,
                ],
            };
        });
        const lazyDefinitions: ReadonlyArray<unknown> = byPlugin.flatMap((entry) => entry.lazy);
        const activities = dropRepeatedIds(byPlugin.flatMap((entry) => entry.activities));
        const panes = dropRepeatedIds([
            ...byPlugin.flatMap((entry) => entry.panes),
            ...hostPanes,
        ]);
        const pendingActivities = pendingPlugins.flatMap((plugin) => {
            return (plugin.manifest?.activities || [])
                .filter((contribution) => {
                    return !activities.some((activity) => activity.id === contribution.id);
                })
                .map((contribution) => {
                    return createPendingActivity({
                        plugin,
                        contribution,
                    });
                });
        });
        ensureActivityStates(runningPlugins.flatMap((plugin) => plugin.activities || []));
        syncStarted(runningPlugins);
        observable.setValue({
            ...observable.value,
            response,
            isLoading: false,
            runningPlugins,
            pendingPlugins,
            pendingActivityIds: pendingActivities.map((activity) => activity.id),
            pendingPanes: pendingPlugins
                .flatMap((plugin) => plugin.manifest?.panes || [])
                .filter((contribution) => {
                    return !panes.some((pane) => pane.id === contribution.id);
                }),
            unloadedIds: [
                ...activities,
                ...panes,
            ]
                .filter((entry) => lazyDefinitions.includes(entry))
                .map((entry) => entry.id),
            contributions: {
                activities: [
                    ...activities,
                    ...pendingActivities,
                ],
                panes,
                paneGroupExtensions: runningPlugins.flatMap(
                    (plugin) => plugin.paneGroupExtensions || [],
                ),
                settingsSections: runningPlugins.flatMap((plugin) => {
                    return [
                        ...(plugin.settingsSections || []),
                        ...(plugin.settings ? [createPluginSettingsSection(plugin)] : []),
                    ];
                }),
            },
            problems: {
                ...typedObjectFromEntries(
                    loaded.flatMap((entry) => {
                        return entry.problem
                            ? [
                                  [
                                      entry.plugin.id,
                                      entry.problem,
                                  ] as const,
                              ]
                            : [];
                    }),
                ),
                ...collisionProblems,
            },
            outdatedPluginIds: loaded
                .filter((entry) => entry.isOutdated && entry.definition)
                .map((entry) => entry.plugin.id),
            activityStates: tracking.activityStates,
        });
    }

    /** Applies the latest response again, once there is one, to load what was just requested. */
    function applyRequests() {
        if (tracking.applyCount) {
            void applyResponse(tracking.response);
        }
    }

    /** Loads each plugin of `pluginIds` that isn't loaded yet, once it's active. */
    function requestPlugins(pluginIds: ReadonlyArray<string>) {
        const newIds = pluginIds.filter((pluginId) => {
            return !tracking.requestedPluginIds.includes(pluginId);
        });
        if (!newIds.length) {
            return;
        }
        tracking.requestedPluginIds = [
            ...tracking.requestedPluginIds,
            ...newIds,
        ];
        applyRequests();
    }

    async function load(revision: string | undefined) {
        tracking.fetchedRevision = revision;
        try {
            await applyResponse(await fetchPlugins());
        } catch {
            tracking.fetchedRevision = undefined;
            /** Stops loading while the server can't answer, retrying on the next poll. */
            if (!observable.value.response) {
                await applyResponse(undefined);
            }
        }
    }

    void load(undefined);
    const removeListener = services.folderData.listen(true, ({live}) => {
        const revision = live?.listing.pluginsRevision;
        if (revision && revision !== tracking.fetchedRevision) {
            void load(revision);
        }
    });

    return Object.assign(observable, {
        requestPlugins,
        /** Loads the plugins adding the activities and panes `contributionIds` name. */
        requestContributions(contributionIds: ReadonlyArray<string>) {
            requestPlugins(
                (tracking.response?.plugins || [])
                    .filter((plugin) => {
                        return [
                            ...(plugin.manifest?.activities || []),
                            ...(plugin.manifest?.panes || []),
                        ].some((contribution) => contributionIds.includes(contribution.id));
                    })
                    .map((plugin) => plugin.id),
            );
        },
        /** Loads every active plugin, now and as more turn active. */
        requestAll() {
            if (!tracking.isAllRequested) {
                tracking.isAllRequested = true;
                applyRequests();
            }
        },
        /**
         * Stores the user's choice for a plugin and applies the server's answer. A nullish
         * `decision` forgets the plugin's stored choice.
         */
        async saveDecision(
            requestData: Readonly<{
                pluginId: string;
                decision: PluginDecision | undefined;
                contentHash: string;
            }>,
        ) {
            await applyResponse(
                await fetchApi(pluginDecisionEndpoint, HttpMethod.Put, {
                    requestData: {
                        ...requestData,
                        decision: requestData.decision || null,
                    },
                }),
            );
        },
        destroy() {
            removeListener();
            tracking.stateListenerRemovers.forEach((remove) => remove());
            getObjectTypedValues(tracking.stops).forEach((stops) => {
                stops.forEach((stop) => stop());
            });
            destroyObservable();
        },
    });
}
