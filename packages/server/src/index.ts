import {agentStormService, defaultConfig, type PaneKind} from '@agent-storm/common';
import {HttpMethod, log} from '@augment-vir/common';
import {HttpStatus, implementService, silentServiceLogger} from '@rest-vir/implement-service';
import {attachService} from '@rest-vir/run-service';
import fastify from 'fastify';
import {ensureAuthSecret} from './auth.js';
import {loadConfig, saveConfig} from './config.js';
import {
    attachPane,
    killFolderPanes,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {buildAllFolderInfo} from './folder-info.js';
import {addWorktree, removeWorktree} from './git.js';
import {saveUpload} from './uploads.js';

/**
 * Backend listen port and the frontend's listen port come from
 * `packages/scripts/src/start.script.ts` via env so each `npm start` gets fresh, conflict-free
 * ports. The frontend port is used below to install a CORS origin guard so only the matching vite
 * dev server (on any LAN hostname, on this port) is accepted — the auth secret in `createContext`
 * is the actual security boundary, but a port-scoped origin check is cheap defense-in-depth.
 */
const port = Number(process.env.BACKEND_PORT) || 41880;
const frontendPort = Number(process.env.FRONTEND_PORT) || undefined;

/**
 * Override the service's `requiredClientOrigin` with a function that matches any origin whose port
 * equals the live frontend port. This is wider than a single string allowlist (works for
 * `localhost`, `127.0.0.1`, and arbitrary LAN IPs without re-listing them) but tighter than
 * `AnyOrigin` (a random page on the user's LAN can't impersonate the frontend just because it runs
 * on port 80).
 *
 * `defineService` copies `requiredClientOrigin` into a per-endpoint `minimalService` object that
 * the CORS handler reads at request time (see `handleCors` in @rest-vir/run-service). All
 * endpoints
 *
 * - Websockets share the same `minimalService` instance, so mutating it via any one endpoint's
 *   `.service` reference propagates everywhere. Mutating the top-level
 *   `agentStormService.requiredClientOrigin` does NOT propagate, because the inner object was
 *   captured before this code runs.
 */
if (frontendPort !== undefined) {
    const portGuard = (origin: string | undefined): boolean => {
        if (!origin) {
            return false;
        }
        try {
            const parsed = new URL(origin);
            return parsed.port === String(frontendPort);
        } catch {
            return false;
        }
    };
    const sampleEndpoint = Object.values(agentStormService.endpoints)[0];
    if (sampleEndpoint) {
        (sampleEndpoint.service as {requiredClientOrigin: unknown}).requiredClientOrigin =
            portGuard;
    }
    (agentStormService as {requiredClientOrigin: unknown}).requiredClientOrigin = portGuard;
}

type SocketAttachment = {
    attachment: PaneAttachment;
    folder: string;
    kind: PaneKind;
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

await ensureDaemon();

const authSecret = await ensureAuthSecret();

function extractBearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== 'string') {
        return undefined;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match ? match[1] : undefined;
}

const implementation = implementService({
    service: agentStormService,
    customHeaders: ['Authorization'],
    /**
     * Mute the framework's per-request info chatter (each request, websocket open/close, etc.) but
     * keep its default error logger — runtime failures still need to surface. `error: undefined`
     * here would fall back to the default, so we only override `info`.
     */
    logger: {
        info: silentServiceLogger.info,
    },
    createContext({requestHeaders, webSocketDefinition}) {
        const provided = webSocketDefinition
            ? typeof requestHeaders['sec-websocket-protocol'] === 'string'
                ? requestHeaders['sec-websocket-protocol'].trim()
                : undefined
            : extractBearerToken(requestHeaders.authorization);
        if (provided !== authSecret) {
            return {
                reject: {
                    statusCode: HttpStatus.Unauthorized,
                    responseErrorMessage: 'Unauthorized',
                },
            };
        }
        return {
            context: undefined,
        };
    },
})({
    endpoints: {
        async '/config'({method, requestData}) {
            if (method === HttpMethod.Get) {
                const config = await loadConfig();
                return {
                    statusCode: HttpStatus.Ok,
                    responseData: config,
                };
            } else if (!requestData) {
                return {
                    statusCode: HttpStatus.BadRequest,
                    responseErrorMessage: 'Missing config body.',
                };
            }
            await saveConfig(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: requestData,
            };
        },
        async '/folders'() {
            const config = await loadConfig().catch(() => defaultConfig);
            const folders = await buildAllFolderInfo(config);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    folders,
                },
            };
        },
        async '/worktrees/create'({requestData}) {
            await addWorktree(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/delete'({requestData}) {
            await removeWorktree(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/restart'({requestData}) {
            await restartPane(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/kill'({requestData}) {
            await killFolderPanes(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/daemon/restart'() {
            await shutdownDaemon().catch(() => {
                /* daemon may already be down; ensureDaemon below will respawn */
            });
            await waitForDaemonGone(3000);
            await ensureDaemon();
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/uploads/create'({requestData}) {
            const path = await saveUpload(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    path,
                },
            };
        },
    },
    webSockets: {
        '/pty': {
            async open({webSocket, searchParams}) {
                const folder = searchParams.folder[0];
                const kind = searchParams.kind[0];
                const attachment = await attachPane({
                    folder,
                    kind,
                    onData(data) {
                        webSocket.send(data);
                    },
                    async onExit() {
                        await webSocket.close();
                    },
                });
                attachmentsByWebSocket.set(webSocket, {
                    attachment,
                    folder,
                    kind,
                });
            },
            message({webSocket, message}) {
                const socketAttachment = attachmentsByWebSocket.get(webSocket);
                if (!socketAttachment) {
                    return;
                }
                if (typeof message === 'string') {
                    socketAttachment.attachment.write(message);
                    return;
                }
                socketAttachment.attachment.resize(message.resize.cols, message.resize.rows);
            },
            close({webSocket}) {
                const socketAttachment = attachmentsByWebSocket.get(webSocket);
                socketAttachment?.attachment.close();
                attachmentsByWebSocket.delete(webSocket);
            },
        },
    },
});

/**
 * Custom Fastify instance so we can raise `bodyLimit` past Fastify's 1 MB default. Image uploads
 * (screenshots dragged into a terminal) get base64-encoded inside a JSON body and that runs past
 * the default in a hurry.
 */
const server = fastify({
    bodyLimit: 25 * 1024 * 1024,
});
await attachService(server, implementation, {
    throwErrorsForExternalHandling: false,
});
/**
 * Bind to `0.0.0.0` so the dev server is reachable over LAN (testing the UI from a phone or another
 * laptop after running the vite frontend with `--host`). The auth-secret check in `createContext`
 * is what actually keeps a LAN attacker out — the bind alone is just a reachability concern.
 */
const listenAddress = await server.listen({
    port,
    host: '0.0.0.0',
});

log.success(`agent-storm server listening on ${listenAddress}`);
log.info(`auth secret: ${authSecret}`);
