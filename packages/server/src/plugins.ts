import {
    PluginDecision,
    pluginManifestFileName,
    pluginManifestShape,
    PluginStatus,
    type PluginDecisionRecord,
    type PluginEntry,
} from '@agent-storm/common';
import {extractErrorMessage, log} from '@augment-vir/common';
import {builtInPlugins} from 'agent-storm';
import {tryGit} from 'agent-storm-util';
import {createHash} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import {lstat, mkdir, readdir, readFile, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative} from 'node:path';
import {parseJsonWithShape} from 'object-shape-tester';
import {loadAppState, updateAppState} from './app-state.js';
import {readRunningCoreVersion} from './core-version.js';
import {findBuiltInPluginDir, pluginsDir} from './file-paths.js';
import {isCoreVersionInRange, isValidCoreVersionRange} from './plugin-compat.js';

/** One plugin folder as read from disk. */
type PluginFolder = Readonly<{
    plugin: Readonly<Omit<PluginEntry, 'status'>>;
    /** The browser entry's text, exactly as `contentHash` hashed it. */
    code: string | undefined;
    /** The server entry's file, when the plugin has one. */
    serverPath: string | undefined;
    /**
     * Hashes only what the server part runs, so rebuilding the browser bundle doesn't restart it
     * and end its in-flight work.
     */
    serverHash: string;
    /** The folders holding the manifest and the entries, which changes are watched in. */
    watchedDirs: ReadonlyArray<string>;
}>;

/** Reads the entry at `entry`, relative to `folder` and inside it. */
async function readEntry({entry, folder}: Readonly<{entry: string; folder: string}>) {
    const path = join(folder, entry);
    await assertInsideFolder({
        path,
        folder,
    });
    return {
        path,
        code: await readFile(path, 'utf8'),
    };
}

/** Throws when `path` isn't inside `folder`, following symlinks. */
async function assertInsideFolder({path, folder}: Readonly<{path: string; folder: string}>) {
    const pathFromFolder = relative(folder, await realpath(path));
    if (!pathFromFolder || pathFromFolder.startsWith('..') || isAbsolute(pathFromFolder)) {
        throw new Error(`${path} is outside the plugin's folder.`);
    }
}

async function readPluginFolder({
    folderPath,
    isBuiltIn,
    name,
}: Readonly<{
    folderPath: string;
    isBuiltIn: boolean;
    /** The plugin's id until its manifest is read, and its folder name. */
    name: string;
}>): Promise<PluginFolder> {
    const isSymlink = !!(await lstat(folderPath).catch(() => undefined))?.isSymbolicLink();
    const realPath = await realpath(folderPath).catch(() => folderPath);
    const base = {
        id: name,
        isBuiltIn,
        folderName: name,
        realPath,
        isSymlink,
        gitRemote:
            (
                await tryGit(realPath, [
                    'remote',
                    'get-url',
                    'origin',
                ])
            )?.trim() || '',
        contentHash: '',
        manifest: null,
        problem: '',
    };
    try {
        const manifestPath = join(realPath, pluginManifestFileName);
        const manifestText = await readFile(manifestPath, 'utf8').catch((error: unknown) => {
            throw new Error(`Its ${pluginManifestFileName} can't be read.`, {
                cause: error,
            });
        });
        const manifest = parseJsonWithShape(manifestText, pluginManifestShape);
        if (!manifest.id.trim()) {
            throw new Error(`Its ${pluginManifestFileName} has no id.`);
        } else if (!isValidCoreVersionRange(manifest.coreVersionRange)) {
            throw new Error(
                `Its coreVersionRange '${manifest.coreVersionRange}' isn't a valid semver range.`,
            );
        }
        const browser = await readEntry({
            entry: manifest.browserEntry,
            folder: realPath,
        });
        const server = manifest.serverEntry
            ? await readEntry({
                  entry: manifest.serverEntry,
                  folder: realPath,
              })
            : undefined;
        return {
            plugin: {
                ...base,
                id: manifest.id,
                manifest,
                contentHash: createHash('sha256')
                    .update(manifestText)
                    .update('\0')
                    .update(browser.code)
                    .update('\0')
                    .update(server?.code || '')
                    .digest('hex'),
            },
            code: browser.code,
            serverPath: server?.path,
            serverHash: createHash('sha256')
                .update(manifestText)
                .update('\0')
                .update(server?.code || '')
                .digest('hex'),
            watchedDirs: [
                realPath,
                dirname(browser.path),
                ...(server ? [dirname(server.path)] : []),
            ],
        };
    } catch (error) {
        return {
            plugin: {
                ...base,
                problem: extractErrorMessage(error),
            },
            code: undefined,
            serverPath: undefined,
            serverHash: '',
            watchedDirs: [
                realPath,
            ],
        };
    }
}

/**
 * Every plugin folder: the built-in ones in order, then the plugins folder's by name. A later
 * folder with an id an earlier one has is invalid.
 */
async function readPluginFolders() {
    await mkdir(pluginsDir, {
        recursive: true,
    });
    const names = (await readdir(pluginsDir)).filter((name) => !name.startsWith('.')).toSorted();
    const directoryNames = (
        await Promise.all(
            names.map(async (name) => {
                const isDirectory = (
                    await stat(join(pluginsDir, name)).catch(() => undefined)
                )?.isDirectory();
                /** A broken symlink still lists, so its problem shows. */
                const isBrokenLink =
                    !isDirectory && (await lstat(join(pluginsDir, name))).isSymbolicLink();
                return isDirectory || isBrokenLink ? [name] : [];
            }),
        )
    ).flat();
    const folders = await Promise.all([
        ...builtInPlugins.map(async (builtIn) => {
            return await readPluginFolder({
                folderPath: findBuiltInPluginDir(builtIn.id),
                isBuiltIn: true,
                name: builtIn.id,
            });
        }),
        ...directoryNames.map(async (name) => {
            return await readPluginFolder({
                folderPath: join(pluginsDir, name),
                isBuiltIn: false,
                name,
            });
        }),
    ]);
    return folders.map((folder, index): PluginFolder => {
        const earlier = folders
            .slice(0, index)
            .find((other) => other.plugin.id === folder.plugin.id);
        return earlier
            ? {
                  ...folder,
                  plugin: {
                      ...folder.plugin,
                      problem: `The plugin in ${earlier.plugin.folderName} already has the id '${folder.plugin.id}'.`,
                  },
                  code: undefined,
                  serverPath: undefined,
              }
            : folder;
    });
}

/** A plugin's status before its dependencies are checked. */
function findOwnPluginStatus({
    plugin,
    decision,
    coreVersion,
}: Readonly<{
    plugin: Readonly<Omit<PluginEntry, 'status'>>;
    decision: Readonly<PluginDecisionRecord> | undefined;
    coreVersion: string;
}>) {
    if (plugin.problem) {
        return PluginStatus.Invalid;
    } else if (
        plugin.manifest &&
        !isCoreVersionInRange({
            coreVersion,
            coreVersionRange: plugin.manifest.coreVersionRange,
        })
    ) {
        return PluginStatus.IncompatibleCore;
    } else if (plugin.isBuiltIn) {
        return decision?.decision === PluginDecision.Blocked
            ? PluginStatus.Blocked
            : decision ||
                builtInPlugins.find((builtIn) => builtIn.id === plugin.id)?.isEnabledByDefault
              ? PluginStatus.Active
              : PluginStatus.Disabled;
    } else if (!decision) {
        return PluginStatus.NeedsApproval;
    }
    const statusByDecision: Readonly<Record<PluginDecision, PluginStatus>> = {
        [PluginDecision.Approved]:
            decision.contentHash === plugin.contentHash
                ? PluginStatus.Active
                : PluginStatus.Changed,
        [PluginDecision.TrustedWhileDeveloping]: plugin.isSymlink
            ? PluginStatus.Active
            : PluginStatus.NeedsApproval,
        [PluginDecision.Blocked]: PluginStatus.Blocked,
    };
    return statusByDecision[decision.decision];
}

/**
 * Marks each active plugin that depends on a plugin that isn't active, repeating until no more
 * change, so a plugin depending on one that's missing its own dependency stops too. The return type
 * is annotated because the recursion keeps TypeScript from inferring it.
 */
function applyDependencies(plugins: ReadonlyArray<PluginEntry>): PluginEntry[] {
    const activeIds = plugins
        .filter((plugin) => plugin.status === PluginStatus.Active)
        .map((plugin) => plugin.id);
    const updated = plugins.map((plugin) => {
        return plugin.status === PluginStatus.Active &&
            (plugin.manifest?.dependencies || []).some(
                (dependency) => !activeIds.includes(dependency),
            )
            ? {
                  ...plugin,
                  status: PluginStatus.MissingDependency,
              }
            : plugin;
    });
    /** Each pass can stop plugins that depended on ones the pass stopped. */
    return updated.some((plugin, index) => plugin !== plugins[index])
        ? applyDependencies(updated)
        : updated;
}

async function readPluginsNow() {
    const [
        folders,
        appState,
        coreVersion,
    ] = await Promise.all([
        readPluginFolders(),
        loadAppState(),
        readRunningCoreVersion(),
    ]);
    const decisions = appState.pluginDecisions || [];
    return {
        folders,
        response: {
            pluginsDir,
            coreVersion,
            plugins: applyDependencies(
                folders.map((folder) => {
                    return {
                        ...folder.plugin,
                        status: findOwnPluginStatus({
                            plugin: folder.plugin,
                            decision: decisions.find(
                                (decision) => decision.pluginId === folder.plugin.id,
                            ),
                            coreVersion,
                        }),
                    };
                }),
            ),
            decisions,
        },
    };
}

type PluginsRead = Awaited<ReturnType<typeof readPluginsNow>>;

const pluginsCache: {
    /** Dropped whenever a watched folder or a decision changes. */
    read: Promise<PluginsRead & {revision: string}> | undefined;
    watchers: ReadonlyMap<string, FSWatcher>;
} = {
    read: undefined,
    watchers: new Map(),
};

function forgetPlugins() {
    pluginsCache.read = undefined;
}

function createWatcher(dir: string) {
    try {
        return watch(dir, forgetPlugins).on('error', forgetPlugins);
    } catch (error) {
        log.warning(`Can't watch ${dir} for plugin changes: ${extractErrorMessage(error)}`);
        return undefined;
    }
}

/** Watches exactly the folders `read` depends on, closing watchers on folders it no longer does. */
function syncWatchers({folders}: Readonly<PluginsRead>) {
    const dirs = [
        pluginsDir,
        ...folders.flatMap((folder) => folder.watchedDirs),
    ].filter((dir, index, all) => all.indexOf(dir) === index);
    pluginsCache.watchers.forEach((watcher, dir) => {
        if (!dirs.includes(dir)) {
            watcher.close();
        }
    });
    pluginsCache.watchers = new Map(
        dirs.flatMap((dir) => {
            const watcher = pluginsCache.watchers.get(dir) || createWatcher(dir);
            return watcher
                ? [
                      [
                          dir,
                          watcher,
                      ] as const,
                  ]
                : [];
        }),
    );
}

const pluginChanges: {
    listeners: ReadonlyArray<() => void>;
    /** The revision the listeners last heard about. */
    revision: string | undefined;
} = {
    listeners: [],
    revision: undefined,
};

/**
 * Calls `listener` whenever a read of the plugins answers differently than the last. Reads happen
 * whenever a window polls, or a decision is saved, after a plugin's files changed.
 */
export function listenToPluginChanges(listener: () => void) {
    pluginChanges.listeners = [
        ...pluginChanges.listeners,
        listener,
    ];
}

async function readPluginsCached() {
    if (!pluginsCache.read) {
        pluginsCache.read = readPluginsNow().then((read) => {
            syncWatchers(read);
            const revision = createHash('sha256')
                .update(JSON.stringify(read.response))
                .digest('hex');
            if (revision !== pluginChanges.revision) {
                pluginChanges.revision = revision;
                pluginChanges.listeners.forEach((listener) => listener());
            }
            return {
                ...read,
                revision,
            };
        });
        pluginsCache.read.catch(forgetPlugins);
    }
    return await pluginsCache.read;
}

/** Every plugin and every stored decision. */
export async function readPlugins() {
    return (await readPluginsCached()).response;
}

/** Changes whenever {@link readPlugins} would answer differently. */
export async function readPluginsRevision() {
    return (await readPluginsCached()).revision;
}

/**
 * The browser entry of the active plugin with id `pluginId`. Read fresh, and hashed and served from
 * the same read, so a file changed since approval can't be served under the old approval.
 */
export async function readActivePluginCode(pluginId: string) {
    /**
     * A page load asks for every plugin's code at once, so re-reading every plugin folder (each
     * with a `git` spawn) per request multiplies. Only this plugin's folder is read fresh when its
     * hash still matches the cached status. Any mismatch falls through to a full fresh read.
     */
    const cached = await readPluginsCached();
    const cachedFolder = cached.folders.find((entry) => entry.plugin.id === pluginId);
    const cachedPlugin = cached.response.plugins.find((entry) => entry.id === pluginId);
    const freshFolder =
        cachedFolder && cachedPlugin?.status === PluginStatus.Active
            ? await readPluginFolder({
                  folderPath: cachedFolder.plugin.realPath,
                  isBuiltIn: cachedFolder.plugin.isBuiltIn,
                  name: cachedFolder.plugin.folderName,
              })
            : undefined;
    if (freshFolder?.code && freshFolder.plugin.contentHash === cachedPlugin?.contentHash) {
        return {
            code: freshFolder.code,
            contentHash: freshFolder.plugin.contentHash,
        };
    }
    const {folders, response} = await readPluginsNow();
    const folder = folders.find((entry) => entry.plugin.id === pluginId);
    const plugin = response.plugins.find((entry) => entry.id === pluginId);
    if (!folder?.code || plugin?.status !== PluginStatus.Active) {
        throw new Error(`Plugin '${pluginId}' isn't approved to run.`);
    }
    return {
        code: folder.code,
        contentHash: folder.plugin.contentHash,
    };
}

/**
 * Every active plugin with a server part, read fresh so each `serverHash` matches the files at
 * `serverPath` as they are now.
 */
export async function readActivePluginServers() {
    const {folders, response} = await readPluginsNow();
    return folders.flatMap((folder) => {
        const plugin = response.plugins.find((entry) => entry.id === folder.plugin.id);
        return folder.serverPath && plugin?.status === PluginStatus.Active
            ? [
                  {
                      pluginId: plugin.id,
                      serverHash: folder.serverHash,
                      serverPath: folder.serverPath,
                      dependencies: plugin.manifest?.dependencies || [],
                      optionalDependencies: plugin.manifest?.optionalDependencies || [],
                  },
              ]
            : [];
    });
}

/**
 * Stores `decision` for the plugin with id `pluginId`. Approving an external plugin approves the
 * version whose hash is `contentHash`, and fails once the plugin's files differ from it. Approving
 * a built-in plugin turns it on whatever its files hold.
 */
export async function savePluginDecision({
    pluginId,
    decision,
    contentHash,
}: Readonly<{
    pluginId: string;
    /** Nullish forgets the plugin's decision. */
    decision?: PluginDecision | null | undefined;
    contentHash: string;
}>) {
    if (
        decision === PluginDecision.Approved ||
        decision === PluginDecision.TrustedWhileDeveloping
    ) {
        const {folders} = await readPluginsNow();
        const plugin = folders.find((folder) => folder.plugin.id === pluginId)?.plugin;
        if (!plugin || plugin.problem) {
            throw new Error(`There's no valid plugin with id '${pluginId}' to approve.`);
        } else if (plugin.isBuiltIn) {
            if (decision === PluginDecision.TrustedWhileDeveloping) {
                throw new Error('A built-in plugin is turned on by approving it.');
            }
        } else if (decision === PluginDecision.Approved && plugin.contentHash !== contentHash) {
            throw new Error(`Plugin '${pluginId}' changed since it was shown. Review it again.`);
        } else if (decision === PluginDecision.TrustedWhileDeveloping && !plugin.isSymlink) {
            throw new Error('Only a symlinked plugin can be trusted while you develop it.');
        }
    }
    await updateAppState((state) => {
        return {
            ...state,
            pluginDecisions: [
                ...(state.pluginDecisions || []).filter((entry) => entry.pluginId !== pluginId),
                ...(decision
                    ? [
                          {
                              pluginId,
                              decision,
                              contentHash: decision === PluginDecision.Approved ? contentHash : '',
                          },
                      ]
                    : []),
            ],
        };
    });
    forgetPlugins();
    return await readPlugins();
}
