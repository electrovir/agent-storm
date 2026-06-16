import {readInjectedGlobalData} from './global-data.js';

/**
 * Backend port. Injected by `packages/scripts/src/start.script.ts` at npm-start time as
 * `BACKEND_PORT`, which `packages/frontend/configs/vite.config.ts` inserts into the
 * `VITE_INJECTED_DATA` global via Vite's `define` config at dev-server / build time. Falls back to
 * 41880 if the global isn't present (e.g. you ran vite directly without going through the
 * orchestrator).
 */
const backendPort = readInjectedGlobalData().backendPort || 41_880;

/**
 * The origin the backend is reachable at: whatever host the page itself is served from, on the
 * chosen backend port. `RestVirClient` (in `api-client.ts`) is constructed with this as its
 * `baseUrl`, and the VS Code proxy helpers concatenate their paths onto it. The new rest-vir client
 * takes the origin explicitly rather than reading it off the api definition (the old
 * `serviceOrigin` field is gone), so this is a plain value rather than a load-time mutation of the
 * definition.
 */
export function getBackendBaseUrl(): string {
    if (typeof globalThis.location === 'undefined') {
        return `http://localhost:${backendPort}`;
    }
    const {protocol, hostname} = globalThis.location;
    return `${protocol}//${hostname}:${backendPort}`;
}
