import {type Config} from '@agent-storm/common';
import {log, replaceExtension} from '@augment-vir/common';
import {defineConfig} from '@virmator/frontend/configs/vite.config.base.js';
import {readFileSync, watch} from 'node:fs';
import {homedir} from 'node:os';
import {basename, dirname, resolve} from 'node:path';
import {type Plugin} from 'vite';
import {type InjectedGlobalData} from '../src/util/global-data.js';

function envPort(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/**
 * The same file the settings modal writes through `PUT /config`. Re-derived here rather than
 * imported from `packages/server/src/file-paths.ts`: this package doesn't depend on the server
 * package, and the constant can't move to `@agent-storm/common` without dragging `node:os` into the
 * browser bundle.
 */
const configPath = resolve(homedir(), '.config', 'agent-storm.json');

function readCertPath(): string {
    try {
        return (JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<Config>).tlsCertPath || '';
    } catch {
        /** No config file yet (fresh install) or mid-write; http is the right answer either way. */
        return '';
    }
}

/**
 * Restarts the dev server when `tlsCertPath` changes, so flipping the setting in the app moves
 * between http and https without a manual restart.
 *
 * Watches the whole config file but compares only that one value: agent-storm rewrites this file
 * during routine work (touching a repo, auto-disabling GitHub polling), and restarting on every
 * write would tear down the page constantly.
 */
function tlsRestartPlugin(certPathAtStartup: string): Plugin {
    return {
        name: 'agent-storm-tls-restart',
        configureServer(server) {
            /**
             * A private watch rather than `server.watcher.add(configPath)`: anything on vite's own
             * watcher counts as a project file, and a write to it makes vite reload the page no
             * matter what this plugin decides. agent-storm rewrites the config on nearly every
             * action (selecting a folder, adding a worktree), so that reloaded the app constantly.
             *
             * Watches the directory instead of the file because `saveConfig` renames a temp file
             * over the target, swapping out the inode a file-level watch is holding.
             */
            const configWatcher = watch(dirname(configPath), (_event, fileName) => {
                if (fileName !== basename(configPath) || readCertPath() === certPathAtStartup) {
                    return;
                }
                void server.restart();
            });
            server.httpServer?.once('close', () => configWatcher.close());
        },
    };
}

/**
 * TLS material for the dev server, or undefined to stay on http. The config only asks for the
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
    (baseConfig) => {
        const backendPort = envPort('BACKEND_PORT');
        const certPath = readCertPath();

        return {
            ...baseConfig,
            plugins: [
                ...(baseConfig.plugins || []),
                tlsRestartPlugin(certPath),
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
             * `readInjectedGlobalData()` in `packages/frontend/src/util/global-data.ts`.
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
