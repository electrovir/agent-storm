import {defineConfig} from '@virmator/frontend/configs/vite.config.base.js';
import {resolve} from 'node:path';

function envPort(): number | undefined {
    const raw = process.env.VITE_FRONTEND_PORT;
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
        return {
            ...baseConfig,
            server: {
                ...baseConfig.server,
                /**
                 * Port comes from the npm-start orchestrator
                 * (`packages/scripts/src/start.script.ts`), which picks a free port at launch time
                 * and exports `VITE_FRONTEND_PORT`. Falls through to virmator's default if nothing
                 * was injected.
                 */
                port: envPort() ?? baseConfig.server?.port,
                /**
                 * `host: true` makes vite listen on all interfaces (equivalent to `--host`), so the
                 * dev server is reachable over LAN. The backend matches via `host: '0.0.0.0'` and
                 * the auth secret is what actually gates access.
                 */
                host: true,
            },
        };
    },
);
