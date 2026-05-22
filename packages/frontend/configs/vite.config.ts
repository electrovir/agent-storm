import {defineConfig} from '@virmator/frontend/configs/vite.config.base.js';
import {resolve} from 'node:path';
import {type InjectedGlobalData} from '../src/util/global-data.js';

function envPort(name: string): number | undefined {
    const raw = process.env[name];
    if (!raw) {
        return undefined;
    }
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

export default defineConfig(
    {
        forGitHubPages: true,
        packageDirPath: resolve(import.meta.dirname, '..'),
    },
    (baseConfig) => {
        const backendPort = envPort('BACKEND_PORT');

        return {
            ...baseConfig,
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
                 * `host: true` makes vite listen on all interfaces (equivalent to `--host`), so the
                 * dev server is reachable over LAN. The backend matches via `host: '0.0.0.0'` and
                 * the auth secret is what actually gates access.
                 */
                host: true,
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
