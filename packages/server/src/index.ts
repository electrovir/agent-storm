// cspell:words mkdirs

import {
    agentStormService,
    checkPathEndpoint,
    clientErrorEndpoint,
    configEndpoint,
    createPathEndpoint,
    createWorktreeEndpoint,
    deleteWorktreeEndpoint,
    foldersEndpoint,
    gitDiffFileEndpoint,
    gitDiffStatusEndpoint,
    gitDiscardAllEndpoint,
    gitDiscardFileEndpoint,
    gitDiscardHunkEndpoint,
    gitHubCommentEndpoint,
    gitHubPrEndpoint,
    gitHubReactionEndpoint,
    gitHubResolveThreadEndpoint,
    gitStageAllEndpoint,
    gitStageFileEndpoint,
    gitStageHunkEndpoint,
    hideRepoEndpoint,
    killPanesEndpoint,
    PaneKind,
    ptyWebSocket,
    resetAiSessionEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    sessionRenameEndpoint,
    touchRepoEndpoint,
    updateCheckEndpoint,
    uploadEndpoint,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {HttpMethod, HttpStatus, log, omitObjectKeys, wait} from '@augment-vir/common';
import {type OriginRequirement} from '@rest-vir/api';
import {attachApi, createApiImplementor, implementApi, silentServerLogger} from '@rest-vir/host';
import {getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import fastify from 'fastify';
import {appendFileSync, writeFileSync} from 'node:fs';
import {appendFile, mkdir, stat} from 'node:fs/promises';
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
    killPaneSession,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {clientErrorLogPath, serverLogPath} from './file-paths.js';
import {getCachedFolders, refreshFolderInfoNow, startFolderInfoRefreshLoop} from './folder-info.js';
import {
    discardAllChanges,
    discardFileChanges,
    discardHunkChanges,
    getDiffFileContents,
    getDiffStatus,
    moveHunkAcrossIndex,
    setFileStaged,
    setSideStaged,
} from './git-diff.js';
import {addWorktree, listWorktreeChildren, removeWorktree} from './git.js';
import {fetchFolderPr, postComment, setReaction, setThreadResolved} from './github-pr.js';
import {normalizePath} from './paths.js';
import {getLivePaneSessionIds} from './pty.js';
import {
    createFolderSession,
    forgetFolderSessions,
    reconcileFolderSessions,
    removeFolderSession,
    renameFolderSession,
    resolveSessionId,
    takeFreshAiSession,
} from './sessions.js';
import {getUpdateStatus} from './update-check.js';
import {saveUpload} from './uploads.js';

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

async function resolveAiCmdsForFolder(folder: string) {
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
    const fallbackFolders = parentRepoMatches.filter(check.isTruthy);
    return {
        aiCmd: getFolderAiCmd({
            config,
            folder,
            fallbackFolders,
        }),
        /** Empty when the user hasn't configured one — see {@link getFolderResetAiSessionCmd}. */
        resetAiSessionCmd: getFolderResetAiSessionCmd({
            config,
            folder,
            fallbackFolders,
        }),
    };
}

async function resolveAiCmdForFolder(folder: string): Promise<string | undefined> {
    return (await resolveAiCmdsForFolder(folder))?.aiCmd;
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
        await wait({
            milliseconds: 250,
        });
        await removeWorktree(requestData);
        /**
         * Drop the folder's session tabs now that the folder is gone. Worktree paths are derived
         * deterministically from the worktree name, so leaving them behind means a later worktree
         * created with the same name inherits this one's named, PTY-less tabs.
         */
        await forgetFolderSessions(requestData.worktreePath);
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

/**
 * Reads the folder's tab list, merged with whatever sessions the daemon actually holds a PTY for,
 * so a running session can never lack a tab. Also materializes the implicit first session for
 * folders that predate multi-session.
 */
const sessionListImplementation = implementor.implementEndpoint(sessionListEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const folder = normalizePath(requestData.folder);
        return {
            [HttpStatus.Ok]: {
                responseData: await reconcileFolderSessions({
                    folder,
                    liveSessionIds: {
                        [PaneKind.Ai]: await getLivePaneSessionIds(folder, PaneKind.Ai),
                        [PaneKind.Shell]: await getLivePaneSessionIds(folder, PaneKind.Shell),
                    },
                }),
            },
        };
    },
});

const sessionCreateImplementation = implementor.implementEndpoint(sessionCreateEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await createFolderSession({
                    folder: normalizePath(requestData.folder),
                    kind: requestData.kind,
                }),
            },
        };
    },
});

const sessionRenameImplementation = implementor.implementEndpoint(sessionRenameEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await renameFolderSession({
                    folder: normalizePath(requestData.folder),
                    kind: requestData.kind,
                    sessionId: requestData.sessionId,
                    name: requestData.name,
                }),
            },
        };
    },
});

const sessionCloseImplementation = implementor.implementEndpoint(sessionCloseEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const folder = normalizePath(requestData.folder);
        const {sessions, removed} = await removeFolderSession({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId,
        });
        /**
         * Only kill the PTY once the store actually dropped the tab. Closing the last remaining
         * session is refused store-side, and killing its process while the tab stays visible would
         * leave the user looking at a dead terminal with no obvious way to revive it.
         */
        if (removed) {
            await killPaneSession({
                folder,
                kind: requestData.kind,
                sessionId: requestData.sessionId,
            }).catch(() => {
                /* no live PTY for this session (never attached, or daemon restarted) */
            });
        }
        return {
            [HttpStatus.Ok]: {
                responseData: sessions,
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
        const folder = normalizePath(requestData.folder);
        await restartPane({
            folder,
            kind: requestData.kind,
            sessionId: await resolveSessionId({
                folder,
                kind: requestData.kind,
                sessionId: requestData.sessionId ?? undefined,
            }),
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
         * "Kill folder panes" means all of them, so the tab lists go too — the folder should come
         * back with a clean single tab per kind rather than a row of tabs whose PTYs are all dead.
         */
        await forgetFolderSessions(requestData.folder);
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
            sessionId: await resolveSessionId({
                folder,
                kind: PaneKind.Ai,
                sessionId: requestData.sessionId ?? undefined,
            }),
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

const clientErrorImplementation = implementor.implementEndpoint(clientErrorEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * One JSON object per line so the file can be tailed and grepped. Append failures are
         * swallowed: a crash reporter that itself errors would turn one frontend bug into two.
         */
        await appendFile(
            clientErrorLogPath,
            `${JSON.stringify({
                at: toUtcIsoString(getNowInUtcTimezone()),
                ...requestData,
            })}\n`,
        ).catch(() => {
            /* ignore append errors */
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

const hideRepoImplementation = implementor.implementEndpoint(hideRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * Clear `lastInteractedAtMs` on the owning repo's config entry — the inverse of the touch
         * endpoint. The sidebar's recency filter treats a repo with no timestamp as hidden. Resolve
         * the owning repo exactly like `touchRepo` (a worktree resolves to its parent, else the
         * folder itself) and no-op on unknown folders / transient load failures — best-effort,
         * never error.
         */
        const target = normalizePath(requestData.folder);
        const cached = await getCachedFolders();
        const folder = cached.find((entry) => entry.path === target);
        const repoPath = folder?.parentRepoPath ?? folder?.path ?? target;
        const config = await loadConfig().catch(() => undefined);
        const repoIndex = config?.repos.findIndex((repo) => repo.path === repoPath) ?? -1;
        if (config && repoIndex !== -1) {
            const updatedRepos = config.repos.map((repo, index) =>
                index === repoIndex ? omitObjectKeys(repo, ['lastInteractedAtMs']) : repo,
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

const gitDiffStatusImplementation = implementor.implementEndpoint(gitDiffStatusEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await getDiffStatus(normalizePath(requestData.folder)),
            },
        };
    },
});

const gitDiffFileImplementation = implementor.implementEndpoint(gitDiffFileEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await getDiffFileContents({
                    ...requestData,
                    folder: normalizePath(requestData.folder),
                    oldPath: requestData.oldPath ?? undefined,
                }),
            },
        };
    },
});

const gitStageFileImplementation = implementor.implementEndpoint(gitStageFileEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await setFileStaged({
            ...requestData,
            folder: normalizePath(requestData.folder),
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

const gitStageAllImplementation = implementor.implementEndpoint(gitStageAllEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await setSideStaged({
            ...requestData,
            folder: normalizePath(requestData.folder),
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

const gitStageHunkImplementation = implementor.implementEndpoint(gitStageHunkEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await moveHunkAcrossIndex({
            ...requestData,
            folder: normalizePath(requestData.folder),
            oldPath: requestData.oldPath ?? undefined,
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

const gitDiscardHunkImplementation = implementor.implementEndpoint(gitDiscardHunkEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await discardHunkChanges({
            ...requestData,
            folder: normalizePath(requestData.folder),
            oldPath: requestData.oldPath ?? undefined,
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

const gitDiscardFileImplementation = implementor.implementEndpoint(gitDiscardFileEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await discardFileChanges({
            ...requestData,
            folder: normalizePath(requestData.folder),
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

const gitDiscardAllImplementation = implementor.implementEndpoint(gitDiscardAllEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await discardAllChanges(normalizePath(requestData.folder));
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const gitHubPrImplementation = implementor.implementEndpoint(gitHubPrEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    pr: await fetchFolderPr({
                        folder: normalizePath(requestData.folder),
                        forceRefresh: requestData.forceRefresh,
                    }),
                },
            },
        };
    },
});

const gitHubCommentImplementation = implementor.implementEndpoint(gitHubCommentEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await postComment(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const gitHubReactionImplementation = implementor.implementEndpoint(gitHubReactionEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await setReaction(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const gitHubResolveThreadImplementation = implementor.implementEndpoint(
    gitHubResolveThreadEndpoint,
    {
        async [HttpMethod.Post]({requestData}) {
            await setThreadResolved(requestData);
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        ok: true,
                    },
                },
            };
        },
    },
);

const ptyImplementation = implementor.implementWebSocket(ptyWebSocket, {
    async open({webSocket, searchParams}) {
        const folder = searchParams.folder;
        const kind = searchParams.kind;
        /**
         * Client-requested scrollback line cap (see `ptyWebSocket` search params). Empty or invalid
         * → undefined, which the daemon treats as "replay the full buffer".
         */
        const parsedScrollbackLimit = Number.parseInt(searchParams.scrollbackLimit, 10);
        const scrollbackLimit = Number.isFinite(parsedScrollbackLimit)
            ? parsedScrollbackLimit
            : undefined;
        /**
         * Resolve against the stored tab list so a hand-edited URL or a client whose session list
         * hasn't loaded attaches to a real session rather than spawning a PTY under an id no tab
         * points at.
         */
        const sessionId = await resolveSessionId({
            folder,
            kind,
            sessionId: searchParams.sessionId,
        });
        /**
         * Look up the current AI command from agent-storm's config on every attach so the daemon's
         * spawned PTY (when this is the first attach for the folder + kind pair) uses whatever the
         * user has set. Failure is non-fatal — the daemon falls back to its built-in default
         * (`claude`).
         */
        const aiCmds = await resolveAiCmdsForFolder(folder);
        /**
         * A tab the user just added gets the reset-AI-session command, so it opens a new
         * conversation instead of resuming the one the folder's normal AI command resumes. See
         * {@link takeFreshAiSession}.
         */
        const isFreshAiSession = takeFreshAiSession({
            folder,
            sessionId,
        });
        const attachment = await attachPane({
            folder,
            kind,
            sessionId,
            aiCmd:
                isFreshAiSession && aiCmds?.resetAiSessionCmd
                    ? aiCmds.resetAiSessionCmd
                    : aiCmds?.aiCmd,
            scrollbackLimit,
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
        sessionListImplementation,
        sessionCreateImplementation,
        sessionRenameImplementation,
        sessionCloseImplementation,
        resetAiSessionImplementation,
        clientErrorImplementation,
        restartDaemonImplementation,
        touchRepoImplementation,
        hideRepoImplementation,
        checkPathImplementation,
        createPathImplementation,
        uploadImplementation,
        gitDiffStatusImplementation,
        gitDiffFileImplementation,
        gitStageFileImplementation,
        gitStageAllImplementation,
        gitStageHunkImplementation,
        gitDiscardFileImplementation,
        gitDiscardAllImplementation,
        gitDiscardHunkImplementation,
        gitHubPrImplementation,
        gitHubCommentImplementation,
        gitHubReactionImplementation,
        gitHubResolveThreadImplementation,
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
