import {agentStormService, defaultConfig, type PaneKind} from '@agent-storm/common';
import {HttpMethod, log} from '@augment-vir/common';
import {HttpStatus, implementService} from '@rest-vir/implement-service';
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

const port = 3000;

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
                socketAttachment?.attachment.write(message);
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
const listenAddress = await server.listen({port, host: 'localhost'});

log.success(`agent-storm server listening on ${listenAddress}`);
log.info(`auth secret: ${authSecret}`);
