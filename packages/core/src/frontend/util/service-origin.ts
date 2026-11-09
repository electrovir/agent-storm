import {getInjectedGlobalData} from './global-data.js';

/**
 * Backend port. Injected by `packages/scripts/src/start.script.ts` at npm-start time as
 * `BACKEND_PORT`, which `packages/frontend/configs/vite.config.ts` inserts into the
 * `VITE_INJECTED_DATA` global via Vite's `define` config at dev-server / build time. A release
 * build has none, because its server serves the frontend itself.
 */
const backendPort = getInjectedGlobalData().backendPort;

/**
 * The origin the backend is reachable at: whatever host the page itself is served from, on the
 * chosen backend port, or the page's own origin in a release build. `RestVirClient` (in
 * `api-client.ts`) is constructed with this as its `baseUrl`, and the VS Code proxy helpers
 * concatenate their paths onto it. The new rest-vir client takes the origin explicitly rather than
 * reading it off the api definition (the old `serviceOrigin` field is gone), so this is a plain
 * value rather than a load-time mutation of the definition.
 */
export function getBackendBaseUrl(): string {
    if (typeof globalThis.location === 'undefined') {
        return `http://localhost:${backendPort || 41_880}`;
    }
    const {protocol, hostname, origin} = globalThis.location;
    return backendPort ? `${protocol}//${hostname}:${backendPort}` : origin;
}
