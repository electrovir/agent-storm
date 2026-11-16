import {type Settings} from '@agent-storm/common';
import {type InjectedGlobalData} from '@agent-storm/core/frontend';
import {Debounce, DebounceStyle, log, replaceExtension} from '@augment-vir/common';
import {defineConfig} from '@virmator/frontend/configs/vite.config.base.js';
import {findConfigFile, parseConfigContents} from 'config-vir';
import {existsSync, mkdirSync, readdirSync, readFileSync, watch} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {type Plugin} from 'vite';

function envPort(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/**
 * Where the user's settings file lives, the folder the server's `findSettingsPath` searches.
 * Re-derived here rather than imported from `packages/server/src/file-paths.ts`: this package
 * doesn't depend on the server package, and the constant can't move to `@agent-storm/common`
 * without dragging `node:os` into the browser bundle. `start.script.ts` exports the instance's data
 * dir as `AGENT_STORM_DATA_DIR`.
 */
const userDataDir = process.env.AGENT_STORM_DATA_DIR || resolve(homedir(), '.agent-storm');

/**
 * `--force` empties vite's deps cache on startup, which would pull the optimized deps out from
 * under another instance's dev server running from this checkout.
 */
const instanceName = process.env.AGENT_STORM_INSTANCE;
async function readCertPath() {
    try {
        const settingsPath = await findConfigFile({
            directory: userDataDir,
            baseName: 'settings',
        });
        if (!settingsPath) {
            return '';
        }
        const settings: Partial<Settings> = await parseConfigContents({
            configPath: settingsPath,
        });
        return settings.tlsCertPath || '';
    } catch {
        /** Invalid, mid-write, or more than one settings file; http is the right answer for all. */
        return '';
    }
}

/**
 * Restarts the dev server when `tlsCertPath` changes, so flipping the setting in the app moves
 * between http and https without a manual restart.
 *
 * Watches the whole settings file but compares only that one value: restarting on every settings
 * change would tear down the page constantly.
 */
function tlsRestartPlugin(certPathAtStartup: string): Plugin {
    return {
        name: 'agent-storm-tls-restart',
        configureServer(server) {
            /**
             * A private watch rather than `server.watcher.add(...)`: anything on vite's own watcher
             * counts as a project file, and a write to it makes vite reload the page no matter what
             * this plugin decides.
             *
             * Watches the directory instead of the file because settings are saved by renaming a
             * temp file over the target, swapping out the inode a file-level watch is holding, and
             * because the file may change format. The directory is created first because `watch`
             * throws on a missing one.
             */
            mkdirSync(userDataDir, {
                recursive: true,
            });
            const settingsWatcher = watch(userDataDir, async (_event, fileName) => {
                if (
                    !fileName?.startsWith('settings.') ||
                    (await readCertPath()) === certPathAtStartup
                ) {
                    return;
                }
                await server.restart();
            });
            server.httpServer?.once('close', () => settingsWatcher.close());
        },
    };
}

/**
 * Reloads the page when a built-in plugin's bundle is rebuilt. The page loads plugin code from the
 * server at runtime rather than through vite, so vite never sees it change, and a loaded plugin
 * keeps running its old code until the page reloads.
 *
 * The reload waits a moment: one source change rewrites the browser and server bundles in separate
 * builds, and the server has to notice the new files before the reloaded page asks for them.
 */
function pluginReloadPlugin(): Plugin {
    return {
        name: 'agent-storm-plugin-reload',
        configureServer(server) {
            const packagesDir = resolve(import.meta.dirname, '..', '..');
            const reload = new Debounce(DebounceStyle.AfterWait, {
                milliseconds: 300,
            });
            const watchers = readdirSync(packagesDir)
                .filter((packageName) => packageName.startsWith('plugin-'))
                .map((packageName) => resolve(packagesDir, packageName, 'dist-plugin'))
                .filter((buildDir) => existsSync(buildDir))
                .map((buildDir) => {
                    return watch(buildDir, () => {
                        reload.execute(() => {
                            server.ws.send({
                                type: 'full-reload',
                            });
                        });
                    });
                });
            server.httpServer?.once('close', () => {
                watchers.forEach((watcher) => watcher.close());
            });
        },
    };
}

/**
 * TLS material for the dev server, or undefined to stay on http. The settings only ask for the
 * certificate, so the key is taken to be the file of the same name beside it.
 */
function readTlsOptions(certPath: string) {
    if (!certPath) {
        return undefined;
    }
    const keyPath = replaceExtension({
        path: certPath,
        newExtension: '.key',
    });
    try {
        return {
            cert: readFileSync(certPath),
            key: readFileSync(keyPath),
        };
    } catch (error) {
        /** A bad path shouldn't take the dev server down with it. */
        log.warning(
            `agent-storm: serving over http, failed to read TLS cert "${certPath}" / key "${keyPath}": ${String(error)}`,
        );
        return undefined;
    }
}

export default defineConfig(
    {
        forGitHubPages: true,
        packageDirPath: resolve(import.meta.dirname, '..'),
    },
    async (baseConfig) => {
        const backendPort = envPort('BACKEND_PORT');
        const certPath = await readCertPath();

        return {
            ...baseConfig,
            ...(instanceName
                ? {
                      cacheDir: resolve(
                          import.meta.dirname,
                          '..',
                          'node_modules',
                          `.vite-${instanceName}`,
                      ),
                  }
                : {}),
            optimizeDeps: {
                ...baseConfig.optimizeDeps,
                /**
                 * Virmator re-bundles every dependency on each start, which gives them new URLs, so
                 * a phone downloads all of them again after every restart instead of using its
                 * cache. Vite still re-bundles on its own when the lockfile or this config
                 * changes.
                 */
                force: false,
            },
            worker: {
                ...baseConfig.worker,
                /**
                 * Vite bundles workers as `iife` by default, which can't hold the top-level `await`
                 * in `@augment-vir/common`. Workers are created with `type: 'module'` anyway.
                 */
                format: 'es',
            },
            plugins: [
                ...(baseConfig.plugins || []),
                tlsRestartPlugin(certPath),
                pluginReloadPlugin(),
            ],
            server: {
                ...baseConfig.server,
                /**
                 * Port comes from the npm-start orchestrator
                 * (`packages/scripts/src/start.script.ts`), which picks a free port at launch time
                 * and exports `FRONTEND_PORT`. Falls through to virmator's default if nothing was
                 * injected.
                 */
                port: envPort('FRONTEND_PORT') ?? baseConfig.server?.port,
                /**
                 * Bind to the requested port or fail. Without this vite silently walks upward when
                 * the configured port is held by a stale process, which then breaks every existing
                 * browser tab pointed at the original URL (CORS rejects them because the backend's
                 * port-guard expects an exact `FRONTEND_PORT` match). Better to refuse to start so
                 * the operator gets a clear "port in use" error and can fix it intentionally.
                 */
                strictPort: true,
                /**
                 * `host: true` makes vite listen on all interfaces (equivalent to `--host`), so the
                 * dev server is reachable over LAN. The backend matches via `host: '0.0.0.0'` and
                 * the auth secret is what actually gates access.
                 */
                host: true,
                https: readTlsOptions(certPath),
            },
            /**
             * Inline the orchestrator-picked backend port (and anything else the frontend needs at
             * boot) into the bundle as a single `VITE_INJECTED_DATA` global. Read at runtime via
             * `readInjectedGlobalData()` in `packages/core/src/frontend/util/global-data.ts`.
             */
            define: {
                ...baseConfig.define,
                VITE_INJECTED_DATA: JSON.stringify({
                    backendPort: backendPort ?? null,
                } satisfies InjectedGlobalData),
            },
        };
    },
);
