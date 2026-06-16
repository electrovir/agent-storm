import {
    agentStormService,
    checkPathEndpoint,
    configEndpoint,
    createPathEndpoint,
    createWorktreeEndpoint,
    deleteWorktreeEndpoint,
    foldersEndpoint,
    killPanesEndpoint,
    PaneKind,
    ptyWebSocket,
    resetAiSessionEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    touchRepoEndpoint,
    updateCheckEndpoint,
    uploadEndpoint,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {HttpMethod, HttpStatus, log, wait} from '@augment-vir/common';
import {type OriginRequirement} from '@rest-vir/api';
import {attachApi, createApiImplementor, implementApi, silentServerLogger} from '@rest-vir/host';
import fastify from 'fastify';
import {appendFileSync, writeFileSync} from 'node:fs';
import {mkdir, stat} from 'node:fs/promises';
import {parseUrl} from 'url-vir';
import {initAuth, verifyAuthToken} from './auth.js';
import {startConfigBackupLoop} from './config-backup.js';
import {
    getFolderAiCmd,
    getFolderResetAiSessionCmd,
    loadConfig,
    saveConfig,
    setFolderAiCmd,
    setFolderResetAiSessionCmd,
} from './config.js';
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
import {addWorktree, listWorktreeChildren, removeWorktree} from './git.js';
import {normalizePath} from './paths.js';
import {getUpdateStatus} from './update-check.js';
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
 * dev server (on any LAN hostname, on this port) is accepted — the auth secret in
 * `createHostContext` is the actual security boundary, but a port-scoped origin check is cheap
 * defense-in-depth.
 */
const port = Number(process.env.BACKEND_PORT) || 41_880;
const frontendPort = Number(process.env.FRONTEND_PORT) || undefined;

/**
 * Restrict browser callers to whatever origin is running on the live frontend port. This is wider
 * than a single string allowlist (works for `localhost`, `127.0.0.1`, and arbitrary LAN IPs without
 * re-listing them) but tighter than allowing any origin (a random page on the user's LAN can't
 * impersonate the frontend just because it runs on port 80). Passed to `implementApi` as the
 * api-level `clientOriginRequirement`; when no frontend port was injected we leave it undefined,
 * which accepts any origin (the auth secret is still the real boundary).
 */
const clientOriginRequirement: OriginRequirement | undefined =
    frontendPort === undefined
        ? undefined
        : (origin) => {
              if (!origin) {
                  return false;
              }
              try {
                  return parseUrl(origin).port === String(frontendPort);
              } catch {
                  return false;
              }
          };

type SocketAttachment = {
    attachment: PaneAttachment;
    folder: string;
    kind: PaneKind;
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

await ensureDaemon();

await startFolderInfoRefreshLoop();

startConfigBackupLoop();

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
    /**
     * Read-only use of config — `.catch(() => undefined)` so a transient load failure (file mid-
     * write, etc.) skips the post-worktree cmd instead of throwing through the create endpoint.
     * `loadConfig` now throws on read/parse failure rather than silently returning defaults, which
     * means bare `await loadConfig()` would surface those errors here; the post-worktree cmd is
     * optional, so swallowing is appropriate.
     */
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return;
    }
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

async function resolveAiCmdForFolder(folder: string): Promise<string | undefined> {
    const config = await loadConfig().catch(() => undefined);
    if (!config) {
        return undefined;
    }
    const parentRepoMatches = await Promise.all(
        config.repos.map(async (repo) => {
            const children = await listWorktreeChildren(repo.path);
            return children.includes(folder) ? repo.path : undefined;
        }),
    );
    return getFolderAiCmd({
        config,
        folder,
        fallbackFolders: parentRepoMatches.filter(check.isTruthy),
    });
}

const implementor = createApiImplementor<undefined>()(agentStormService);

const configImplementation = implementor.implementEndpoint(configEndpoint, {
    async [HttpMethod.Get]() {
        const config = await loadConfig();
        return {
            [HttpStatus.Ok]: {
                responseData: config,
            },
        };
    },
    async [HttpMethod.Put]({requestData}) {
        await saveConfig(requestData);
        /**
         * Re-enumerate folder targets now so a freshly-added repo (or removed one) shows up in
         * `/folders` immediately instead of waiting for the next background sweep cycle.
         * `refreshFolderInfoNow` returns once `refreshState.targets` reflects the new layout, so by
         * the time the frontend's follow-up `/folders` poll lands the new entry is already present
         * (git/PR fields fill in over the next sweep).
         */
        await refreshFolderInfoNow();
        return {
            [HttpStatus.Ok]: {
                responseData: requestData,
            },
        };
    },
});

const foldersImplementation = implementor.implementEndpoint(foldersEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    folders: await getCachedFolders(),
                },
            },
        };
    },
});

const updateCheckImplementation = implementor.implementEndpoint(updateCheckEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await getUpdateStatus(),
            },
        };
    },
});

const createWorktreeImplementation = implementor.implementEndpoint(createWorktreeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const {worktreePath} = await addWorktree(requestData);
        const aiCmd = requestData.aiCmd?.trim();
        const resetCmd = requestData.resetAiSessionCmd?.trim();
        if (aiCmd || resetCmd) {
            /**
             * Best-effort overrides write. `loadConfig` throws on read failure rather than
             * returning defaults, so `.catch(() => undefined)` here is what prevents a transient
             * race from kicking us into a "defaults + this override" save that would wipe the
             * user's other settings. Apply both setters in sequence so the second sees the result
             * of the first.
             */
            const initial = await loadConfig().catch(() => undefined);
            if (initial) {
                const withAiCmd = aiCmd
                    ? setFolderAiCmd({
                          config: initial,
                          folder: worktreePath,
                          aiCmd,
                      })
                    : initial;
                const withReset = resetCmd
                    ? setFolderResetAiSessionCmd({
                          config: withAiCmd,
                          folder: worktreePath,
                          resetAiSessionCmd: resetCmd,
                      })
                    : withAiCmd;
                await saveConfig(withReset);
            }
        }
        await refreshFolderInfoNow();
        await runPostWorktreeCmd({
            repoPath: requestData.repoPath,
            worktreePath,
        });
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const deleteWorktreeImplementation = implementor.implementEndpoint(deleteWorktreeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await killFolderPanes({
            folder: requestData.worktreePath,
        }).catch(() => {
            /* if the daemon has no live panes for this folder, continue with deletion */
        });
        await killVscode({
            folder: requestData.worktreePath,
        }).catch(() => {
            /* if no vscode was running for this folder, killVscode is a no-op */
        });
        await wait({
            milliseconds: 250,
        });
        await removeWorktree(requestData);
        await refreshFolderInfoNow();
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const restartPaneImplementation = implementor.implementEndpoint(restartPaneEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * Forward the current `aiCmd` so a "Restart AI" picks up any recent config edits to the AI
         * command (the daemon caches nothing about config — every fresh spawn uses whatever the
         * backend hands it).
         */
        await restartPane({
            ...requestData,
            aiCmd: await resolveAiCmdForFolder(requestData.folder),
        });
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const killPanesImplementation = implementor.implementEndpoint(killPanesEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await killFolderPanes(requestData);
        /**
         * Pair the VS Code instance lifecycle with the pane lifecycle — "kill folder panes" implies
         * "tear down the editor I have for this folder too". Silently ignore the no-vscode case.
         */
        await killVscode({
            folder: requestData.folder,
        }).catch(() => {});
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const resetAiSessionImplementation = implementor.implementEndpoint(resetAiSessionEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * "Restart AI session" is the same daemon-side action as the regular "Restart AI" (kill the
         * pty + spawn a fresh one in the same folder) — the only difference is the command we hand
         * to the daemon: the resolved reset-AI-session string instead of the folder's normal
         * `aiCmd`. Re-resolve from config on every call so a stale frontend that still has the menu
         * rendered after the user cleared the setting just no-ops instead of running whatever it
         * last saw.
         */
        const folder = normalizePath(requestData.folder);
        const config = await loadConfig().catch(() => undefined);
        if (!config) {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        ok: true,
                    },
                },
            };
        }
        const cached = await getCachedFolders();
        const cachedFolder = cached.find((entry) => entry.path === folder);
        const fallbackFolders = cachedFolder?.parentRepoPath ? [cachedFolder.parentRepoPath] : [];
        const cmd = getFolderResetAiSessionCmd({
            config,
            folder,
            fallbackFolders,
        });
        if (!cmd) {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        ok: true,
                    },
                },
            };
        }
        await restartPane({
            folder,
            kind: PaneKind.Ai,
            aiCmd: cmd,
        });
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const restartDaemonImplementation = implementor.implementEndpoint(restartDaemonEndpoint, {
    async [HttpMethod.Post]() {
        await shutdownDaemon().catch(() => {
            /* daemon may already be down; ensureDaemon below will respawn */
        });
        await waitForDaemonGone(3000);
        await ensureDaemon();
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const touchRepoImplementation = implementor.implementEndpoint(touchRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * Stamp `lastInteractedAtMs` on the owning repo's config entry. The given path may be a
         * top-level repo OR a worktree under one; we look up the folder in the cache and use its
         * `parentRepoPath` to resolve the repo. Unknown folders (stale paths, freshly-deleted
         * worktrees, race against folder-info refresh) are no-ops — never error, this is
         * best-effort metadata.
         *
         * `loadConfig` now throws on read failure rather than returning defaults, so the `.catch`
         * here is what prevents a transient load error from triggering a
         * `saveConfig({...defaultConfig, repos: [...]})` reset of the user's other settings.
         * Touching is fire-and-forget metadata; silently skipping a single stamp is the right
         * trade.
         */
        const target = normalizePath(requestData.folder);
        const cached = await getCachedFolders();
        const folder = cached.find((entry) => entry.path === target);
        const repoPath = folder?.parentRepoPath ?? folder?.path ?? target;
        const config = await loadConfig().catch(() => undefined);
        const repoIndex = config?.repos.findIndex((repo) => repo.path === repoPath) ?? -1;
        if (config && repoIndex !== -1) {
            const updatedRepos = config.repos.map((repo, index) =>
                index === repoIndex
                    ? {
                          ...repo,
                          lastInteractedAtMs: Date.now(),
                      }
                    : repo,
            );
            await saveConfig({
                ...config,
                repos: updatedRepos,
            });
        }
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const checkPathImplementation = implementor.implementEndpoint(checkPathEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const resolvedPath = normalizePath(requestData.path);
        const exists = await stat(resolvedPath)
            .then(() => true)
            .catch(() => false);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    resolvedPath,
                    exists,
                },
            },
        };
    },
});

const createPathImplementation = implementor.implementEndpoint(createPathEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * `recursive: true` mkdirs every missing parent and is a no-op if the directory already
         * exists — matches `mkdir -p` semantics, which is what the user expects from "type the path
         * to create".
         */
        const resolvedPath = normalizePath(requestData.path);
        await mkdir(resolvedPath, {
            recursive: true,
        });
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    resolvedPath,
                },
            },
        };
    },
});

const uploadImplementation = implementor.implementEndpoint(uploadEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const path = await saveUpload(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    path,
                },
            },
        };
    },
});

const ptyImplementation = implementor.implementWebSocket(ptyWebSocket, {
    async open({webSocket, searchParams}) {
        const folder = searchParams.folder;
        const kind = searchParams.kind;
        /**
         * Look up the current AI command from agent-storm's config on every attach so the daemon's
         * spawned PTY (when this is the first attach for the folder + kind pair) uses whatever the
         * user has set. Failure is non-fatal — the daemon falls back to its built-in default
         * (`claude`).
         */
        const attachment = await attachPane({
            folder,
            kind,
            aiCmd: await resolveAiCmdForFolder(folder),
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
});

const implementation = implementApi<undefined>()(agentStormService, {
    customHeaders: ['Authorization'],
    /**
     * Mute the framework's per-request info chatter (each request, websocket open/close, etc.) but
     * keep its default error logger — runtime failures still need to surface. Only `info` is
     * overridden; `error` falls back to the default.
     */
    serverLogger: {
        info: silentServerLogger.info,
    },
    clientOriginRequirement,
    async createHostContext({requestHeaders, webSocketDefinition}) {
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
                    responseData: 'Unauthorized',
                },
            };
        }
        return {
            context: undefined,
        };
    },
    endpoints: [
        configImplementation,
        foldersImplementation,
        updateCheckImplementation,
        createWorktreeImplementation,
        deleteWorktreeImplementation,
        restartPaneImplementation,
        killPanesImplementation,
        resetAiSessionImplementation,
        restartDaemonImplementation,
        touchRepoImplementation,
        checkPathImplementation,
        createPathImplementation,
        uploadImplementation,
    ],
    webSockets: [ptyImplementation],
});

/**
 * Custom Fastify instance so we can raise `bodyLimit` past Fastify's 1 MB default. Image uploads
 * (screenshots dragged into a terminal) get base64-encoded inside a JSON body and that runs past
 * the default in a hurry.
 */
const server = fastify({
    bodyLimit: 25 * 1024 * 1024,
});
await attachApi(server, implementation, {
    externalOrigin: `http://localhost:${port}`,
});
/**
 * Mount the embedded-VS-Code proxy after the main service so its `/vscode-proxy/*` route doesn't
 * collide with rest-vir's path handling. Owns its own routes (`/vscode/ensure`, `/vscode/kill`, the
 * proxy itself) and an HTTP-server `upgrade` listener for WebSocket forwarding.
 */
attachVscodeProxy(server);
/**
 * Bind to `0.0.0.0` so the dev server is reachable over LAN (testing the UI from a phone or another
 * laptop after running the vite frontend with `--host`). The auth-secret check in
 * `createHostContext` is what actually keeps a LAN attacker out — the bind alone is just a
 * reachability concern.
 */
const listenAddress = await server.listen({
    port,
    host: '0.0.0.0',
});

log.success(`agent-storm server listening on ${listenAddress}`);
