import {agentStormService, defaultConfig, type PaneKind} from '@agent-storm/common';
import {HttpMethod, log} from '@augment-vir/common';
import {HttpStatus, implementService} from '@rest-vir/implement-service';
import {startService} from '@rest-vir/run-service';
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

const port = 3000;

type SocketAttachment = {
    attachment: PaneAttachment;
    folder: string;
    kind: PaneKind;
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

await ensureDaemon();

const implementation = implementService({
    service: agentStormService,
})({
    endpoints: {
        async '/config'({method, requestData}) {
            if (method === HttpMethod.Get) {
                const config = await loadConfig();
                return {
                    statusCode: HttpStatus.Ok,
                    responseData: config,
                };
            }
            if (!requestData) {
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
                responseData: {folders},
            };
        },
        async '/worktrees/create'({requestData}) {
            await addWorktree(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {ok: true},
            };
        },
        async '/worktrees/delete'({requestData}) {
            await removeWorktree(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {ok: true},
            };
        },
        async '/panes/restart'({requestData}) {
            await restartPane(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {ok: true},
            };
        },
        async '/panes/kill'({requestData}) {
            await killFolderPanes(requestData);
            return {
                statusCode: HttpStatus.Ok,
                responseData: {ok: true},
            };
        },
        async '/daemon/restart'() {
            await shutdownDaemon().catch(() => {
                /* daemon may already be down; ensureDaemon below will respawn */
            });
            await waitForDaemonGone(3_000);
            await ensureDaemon();
            return {
                statusCode: HttpStatus.Ok,
                responseData: {ok: true},
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

const startResult = await startService(implementation, {
    port,
    workerCount: 1,
});

log.success(`agent-storm server listening on http://localhost:${startResult.port}`);
