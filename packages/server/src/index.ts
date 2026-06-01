import {agentStormService, PaneKind} from '@agent-storm/common';
import {HttpMethod, log} from '@augment-vir/common';
import {HttpStatus, implementService, silentServiceLogger} from '@rest-vir/implement-service';
import {attachService} from '@rest-vir/run-service';
import fastify from 'fastify';
import {appendFileSync, writeFileSync} from 'node:fs';
import {mkdir, stat} from 'node:fs/promises';
import {parseUrl} from 'url-vir';
import {initAuth, verifyAuthToken} from './auth.js';
import {loadConfig, saveConfig} from './config.js';
import {
    attachPane,
    killFolderPanes,
    killVscode,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {serverLogPath} from './file-paths.js';
import {getCachedFolders, refreshFolderInfoNow, startFolderInfoRefreshLoop} from './folder-info.js';
import {addWorktree, removeWorktree} from './git.js';
import {normalizePath} from './paths.js';
import {saveUpload} from './uploads.js';
import {attachVscodeProxy} from './vscode-proxy.js';

/**
 * Mirror stdout/stderr to `serverLogPath` so the assistant can tail the backend output instead of
 * asking the user to copy/paste console lines. Truncate on startup so each `npm start` begins with
 * a clean file. The original streams keep going to the terminal — we just `appendFileSync` a copy
 * of each chunk. Wrapped in try/catch so a transient FS error never crashes the backend.
 */
try {
    writeFileSync(serverLogPath, '');
} catch {
    /* ignore truncate errors */
}
function mirrorWriteTo<Stream extends NodeJS.WriteStream>(
    original: Stream['write'],
    stream: Stream,
): Stream['write'] {
    return ((chunk: unknown, ...rest: unknown[]) => {
        try {
            if (typeof chunk === 'string' || chunk instanceof Buffer) {
                appendFileSync(serverLogPath, chunk);
            }
        } catch {
            /* ignore mirror-write errors */
        }
        return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as Stream['write'];
}
process.stdout.write = mirrorWriteTo(process.stdout.write.bind(process.stdout), process.stdout);
process.stderr.write = mirrorWriteTo(process.stderr.write.bind(process.stderr), process.stderr);

/**
 * Backend listen port and the frontend's listen port come from
 * `packages/scripts/src/start.script.ts` via env so each `npm start` gets fresh, conflict-free
 * ports. The frontend port is used below to install a CORS origin guard so only the matching vite
 * dev server (on any LAN hostname, on this port) is accepted — the auth secret in `createContext`
 * is the actual security boundary, but a port-scoped origin check is cheap defense-in-depth.
 */
const port = Number(process.env.BACKEND_PORT) || 41_880;
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
            const parsed = parseUrl(origin);
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

await startFolderInfoRefreshLoop();

await initAuth();

function extractBearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== 'string') {
        return undefined;
    }
    const trimmed = header.trim();
    const schemePrefix = 'bearer ';
    if (trimmed.slice(0, schemePrefix.length).toLowerCase() !== schemePrefix) {
        return undefined;
    }
    return trimmed.slice(schemePrefix.length).trimStart() || undefined;
}

async function runPostWorktreeCmd({
    repoPath,
    worktreePath,
}: Readonly<{
    repoPath: string;
    worktreePath: string;
}>): Promise<void> {
    const config = await loadConfig();
    const repoConfig = config.repos.find((repo) => repo.path === repoPath);
    const cmd = repoConfig?.postWorktreeCmd || config.postWorktreeCmd;
    if (!cmd) {
        return;
    }
    const attachment = await attachPane({
        folder: worktreePath,
        kind: PaneKind.Shell,
        onData() {},
        onExit() {},
    });
    attachment.write(`${cmd}\n`);
    attachment.close();
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
    async createContext({requestHeaders, webSocketDefinition}) {
        const provided = webSocketDefinition
            ? typeof requestHeaders['sec-websocket-protocol'] === 'string'
                ? requestHeaders['sec-websocket-protocol'].trim()
                : undefined
            : extractBearerToken(requestHeaders.authorization);
        const isValid = await verifyAuthToken(provided);
        if (!isValid) {
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
            /**
             * Re-enumerate folder targets now so a freshly-added repo (or removed one) shows up in
             * `/folders` immediately instead of waiting for the next background sweep cycle.
             * `refreshFolderInfoNow` returns once `refreshState.targets` reflects the new layout,
             * so by the time the frontend's follow-up `/folders` poll lands the new entry is
             * already present (git/PR fields fill in over the next sweep).
             */
            await refreshFolderInfoNow();
            return {
                statusCode: HttpStatus.Ok,
                responseData: requestData,
            };
        },
        async '/folders'() {
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    folders: await getCachedFolders(),
                },
            };
        },
        async '/worktrees/create'({requestData}) {
            const {worktreePath} = await addWorktree(requestData);
            await refreshFolderInfoNow();
            await runPostWorktreeCmd({
                repoPath: requestData.repoPath,
                worktreePath,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/worktrees/delete'({requestData}) {
            await killFolderPanes({
                folder: requestData.worktreePath,
            });
            await killVscode({
                folder: requestData.worktreePath,
            }).catch(() => {
                /* if no vscode was running for this folder, killVscode is a no-op */
            });
            await removeWorktree(requestData);
            await refreshFolderInfoNow();
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/restart'({requestData}) {
            /**
             * Forward the current `aiCmd` so a "Restart AI" picks up any recent config edits to the
             * AI command (the daemon caches nothing about config — every fresh spawn uses whatever
             * the backend hands it).
             */
            const config = await loadConfig().catch(() => undefined);
            await restartPane({
                ...requestData,
                aiCmd: config?.aiCmd,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/exit-ai'({requestData}) {
            await restartPane({
                folder: requestData.folder,
                kind: PaneKind.Ai,
                forceShell: true,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    ok: true,
                },
            };
        },
        async '/panes/kill'({requestData}) {
            await killFolderPanes(requestData);
            /**
             * Pair the VS Code instance lifecycle with the pane lifecycle — "kill folder panes"
             * implies "tear down the editor I have for this folder too". Silently ignore the
             * no-vscode case.
             */
            await killVscode({
                folder: requestData.folder,
            }).catch(() => {});
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
        async '/paths/check'({requestData}) {
            const resolvedPath = normalizePath(requestData.path);
            const exists = await stat(resolvedPath)
                .then(() => true)
                .catch(() => false);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    resolvedPath,
                    exists,
                },
            };
        },
        async '/paths/create'({requestData}) {
            /**
             * `recursive: true` mkdirs every missing parent and is a no-op if the directory already
             * exists — matches `mkdir -p` semantics, which is what the user expects from "type the
             * path to create".
             */
            const resolvedPath = normalizePath(requestData.path);
            await mkdir(resolvedPath, {
                recursive: true,
            });
            return {
                statusCode: HttpStatus.Ok,
                responseData: {
                    resolvedPath,
                },
            };
        },
    },
    webSockets: {
        '/pty': {
            async open({webSocket, searchParams}) {
                const folder = searchParams.folder[0];
                const kind = searchParams.kind[0];
                /**
                 * Look up the current AI command from agent-storm's config on every attach so the
                 * daemon's spawned PTY (when this is the first attach for the folder + kind pair)
                 * uses whatever the user has set. Failure is non-fatal — the daemon falls back to
                 * its built-in default (`claude`).
                 */
                const config = await loadConfig().catch(() => undefined);
                const attachment = await attachPane({
                    folder,
                    kind,
                    aiCmd: config?.aiCmd,
                    onData(data) {
                        webSocket.send(data);
                    },
                    async onExit(exitCode) {
                        if (exitCode == undefined) {
                            await webSocket.close();
                        }
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
                } else if (typeof message === 'string') {
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
 * Mount the embedded-VS-Code proxy after the main service so its `/vscode-proxy/*` route doesn't
 * collide with rest-vir's path handling. Owns its own routes (`/vscode/ensure`, `/vscode/kill`, the
 * proxy itself) and an HTTP-server `upgrade` listener for WebSocket forwarding.
 */
attachVscodeProxy(server);
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
