import {agentStormService} from '@agent-storm/common';
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
 * Patch `serviceOrigin` at module load to point at whatever host the page itself is served from on
 * the chosen backend port.
 *
 * `defineService` doesn't store `serviceOrigin` only on the top-level service object — it also
 * copies it into a `minimalService` inner object that every endpoint + websocket references by
 * value (see `finalizeServiceDefinition` in @rest-vir/define-service). `fetchEndpoint` and
 * `connectWebSocket` read the URL from THAT inner copy, not the top-level field, so we need to
 * mutate both. All endpoints + websockets share the same `minimalService` instance, so mutating via
 * any one endpoint's `.service` reference propagates everywhere.
 *
 * Importing this module for its side effect (one line in `vir-app.element.ts`) is what wires it up
 * — there's no API surface.
 */
function configureServiceOrigin(): void {
    if (typeof globalThis.location === 'undefined') {
        return;
    }
    const {protocol, hostname} = globalThis.location;
    const nextOrigin = `${protocol}//${hostname}:${backendPort}`;
    (agentStormService as {serviceOrigin: string}).serviceOrigin = nextOrigin;
    const inner =
        Object.values(agentStormService.endpoints)[0]?.service ??
        Object.values(agentStormService.webSockets)[0]?.service;
    if (inner) {
        (inner as {serviceOrigin: string}).serviceOrigin = nextOrigin;
    }
}

configureServiceOrigin();
