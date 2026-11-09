// cspell:words mkdirs

import {
    activityBarSaveEndpoint,
    addReviewCommentEndpoint,
    agentStormService,
    aiAvatarEndpoint,
    aiAvatarUploadEndpoint,
    checkPathEndpoint,
    clientErrorEndpoint,
    closeEditorWindowEndpoint,
    configEndpoint,
    createPathEndpoint,
    createWorktreeEndpoint,
    deleteReviewCommentEndpoint,
    deleteWorktreeEndpoint,
    foldersEndpoint,
    gitDiffFileEndpoint,
    gitDiffStatusEndpoint,
    gitDiscardFileEndpoint,
    gitDiscardHunkEndpoint,
    gitDiscardUnstagedEndpoint,
    gitHubAssigneeQueueEndpoint,
    gitHubCommentEndpoint,
    gitHubPrEndpoint,
    gitHubReactionEndpoint,
    gitHubResolveThreadEndpoint,
    gitHubReviewFolderEndpoint,
    gitHubReviewPrEndpoint,
    gitHubReviewQueueEndpoint,
    gitStageAllEndpoint,
    gitStageFileEndpoint,
    gitStageHunkEndpoint,
    hideRepoEndpoint,
    killPanesEndpoint,
    manualReviewCopyEndpoint,
    manualReviewStateEndpoint,
    paneInputEndpoint,
    PaneKind,
    paneKindRunsAi,
    ptyWebSocket,
    readReviewCommentsEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    reviewConfigEndpoint,
    reviewInitEndpoint,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    sessionRenameEndpoint,
    sessionSetAiEndpoint,
    tabLayoutSaveEndpoint,
    touchRepoEndpoint,
    uiLayoutEndpoint,
    updateCheckEndpoint,
    updateReviewCommentEndpoint,
    uploadEndpoint,
    watchModeEndpoint,
    type RepoConfig,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    convertByteSize,
    HttpMethod,
    HttpStatus,
    log,
    mapEnumToObject,
    omitObjectKeys,
    replaceExtension,
    wait,
} from '@augment-vir/common';
import {type OriginRequirement} from '@rest-vir/api';
import {attachApi, createApiImplementor, implementApi, silentServerLogger} from '@rest-vir/host';
import {getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import fastify from 'fastify';
import {appendFileSync, writeFileSync} from 'node:fs';
import {appendFile, mkdir, readFile, stat} from 'node:fs/promises';
import {parseUrl} from 'url-vir';
import {getFolderActivation, startLaunchRequestWatch, type LaunchRequest} from './agent-launch.js';
import {readAiAvatar, saveAiAvatar} from './ai-avatar.js';
import {extractBearerToken, initAuth, verifyAuthToken} from './auth.js';
import {recordClaudeInterrupt} from './claude-activity.js';
import {startConfigBackupLoop} from './config-backup.js';
import {loadConfig, readConfigRevision, saveConfig, setFolderAiId, updateConfig} from './config.js';
import {
    attachPane,
    killFolderPanes,
    killPaneSession,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {
    clientErrorLogPath,
    folderActivityPath,
    instanceName,
    legacyFolderActivityPath,
    legacyReviewsDir,
    legacySessionStorePath,
    manualReviewSkillDir,
    serverLogPath,
    sessionStorePath,
} from './file-paths.js';
import {forgetFolderActivity, loadFolderActivity, recordFolderActivity} from './folder-activity.js';
import {getCachedFolders, refreshFolderInfoNow, startFolderInfoRefreshLoop} from './folder-info.js';
import {
    discardFileChanges,
    discardHunkChanges,
    discardUnstagedChanges,
    getDiffFileContents,
    getDiffStatus,
    moveHunkAcrossIndex,
    setFileStaged,
    setSideStaged,
} from './git-diff.js';
import {
    addWorktree,
    findManualReviewCopy,
    removeWorktree,
    sweepDeletingReviewFolders,
} from './git.js';
import {fetchFolderPr, postComment, setReaction, setThreadResolved} from './github-pr.js';
import {
    closeReviewWindow,
    readAssigneeQueue,
    readReviewPr,
    readReviewQueue,
    refreshAssigneeQueue,
    refreshReviewQueue,
    resolveReviewFolder,
    startPostedVerdictWatch,
} from './github-review-queue.js';
import {installClaudeHooks} from './install-claude-hooks.js';
import {readManualReviewState} from './manual-review-state.js';
import {migrateReviewFolders} from './migrate-review-folders.js';
import {
    launchFolderSession,
    resolveAiForSession,
    resolvePaneLaunch,
    runPostWorktreeCmd,
    runReviewInitCmd,
    sendPaneText,
    spawnPane,
} from './pane-launch.js';
import {normalizePath} from './paths.js';
import {defaultPorts, PortEnvVar, readEnvPort} from './ports.js';
import {getLivePaneSessionIds, invalidatePaneStatuses} from './pty.js';
import {startReviewAutoStart} from './review-auto-start.js';
import {
    addReviewComment,
    deleteReviewComment,
    readReviewComments,
    updateReviewComment,
} from './review-comments.js';
import {loadReviewConfig, saveReviewConfig} from './review-config.js';
import {
    createFolderSession,
    forgetFolderSessions,
    getFolderSessions,
    isFolderSessionRemovable,
    pruneSessionAiIds,
    reconcileFolderSessions,
    removeFolderSession,
    renameFolderSession,
    resolveSessionId,
    setFolderSessionAi,
    startNewConversation,
} from './sessions.js';
import {
    deleteFolderState,
    loadUiLayout,
    pruneFolderStates,
    readUiLayoutRevision,
    saveActivityBar,
    saveTabLayout,
} from './ui-layout.js';
import {getUpdateStatus} from './update-check.js';
import {saveUpload} from './uploads.js';
import {getWatchModeInfo, setWatchMode, startWatchMode} from './watch-mode.js';

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
            if (check.isString(chunk) || chunk instanceof Buffer) {
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
 * Both ports come from `packages/scripts/src/start.script.ts` via env. The frontend port is used
 * below to install a CORS origin guard so only the matching vite dev server (on any LAN hostname,
 * on this port) is accepted — the auth secret in `createHostContext` is the actual security
 * boundary, but a port-scoped origin check is cheap defense-in-depth.
 */
const port = readEnvPort(PortEnvVar.Backend) ?? defaultPorts[PortEnvVar.Backend];
const frontendPort = readEnvPort(PortEnvVar.Frontend);

/**
 * Restrict browser callers to whatever origin is running on the live frontend port. This is wider
 * than a single string allowlist (works for `localhost`, `127.0.0.1`, and arbitrary LAN IPs without
 * re-listing them) but tighter than allowing any origin (a random page on the user's LAN can't
 * impersonate the frontend just because it runs on port 80). Passed to `implementApi` as the
 * api-level `clientOriginRequirement`; when no frontend port was injected we leave it undefined,
 * which accepts any origin (the auth secret is still the real boundary).
 */
const clientOriginRequirement: OriginRequirement | undefined =
    frontendPort == undefined
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
    /** Set only for AI panes, whose interrupt key presses feed {@link recordClaudeInterrupt}. */
    conversationId: string | undefined;
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

/**
 * The hooks go first so running Claude sessions stop writing to the old conversation state folder
 * before it's moved.
 */
await installClaudeHooks();

await migrateReviewFolders({
    reviewsDir: manualReviewSkillDir,
    legacyReviewsDir,
    folderKeyedFiles: [
        {
            legacyPath: legacySessionStorePath,
            path: sessionStorePath,
        },
        {
            legacyPath: legacyFolderActivityPath,
            path: folderActivityPath,
        },
    ],
});
void sweepDeletingReviewFolders();
void pruneFolderStates();

await ensureDaemon();

await loadFolderActivity();

await startFolderInfoRefreshLoop();

startConfigBackupLoop();

startPostedVerdictWatch();

await startWatchMode({
    listFolders: getCachedFolders,
    spawnPane,
    sendPaneText,
});
/**
 * A named instance is a debug copy using the user's own GitHub login, so auto-started reviews would
 * act on the user's real PRs.
 */
if (!instanceName) {
    startReviewAutoStart({
        launchFolderSession,
        runReviewInitCmd,
    });
}

await initAuth();

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
        await pruneSessionAiIds({
            validAiIds: requestData.aiDefinitions.map((definition) => definition.id),
        });
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
                responseData: await loadConfig(),
            },
        };
    },
});

const reviewConfigImplementation = implementor.implementEndpoint(reviewConfigEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await loadReviewConfig(),
            },
        };
    },
    async [HttpMethod.Put]({requestData}) {
        await saveReviewConfig(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: await loadReviewConfig(),
            },
        };
    },
});

const uiLayoutImplementation = implementor.implementEndpoint(uiLayoutEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await loadUiLayout(),
            },
        };
    },
});

const tabLayoutSaveImplementation = implementor.implementEndpoint(tabLayoutSaveEndpoint, {
    async [HttpMethod.Put]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await saveTabLayout(requestData),
            },
        };
    },
});

const activityBarSaveImplementation = implementor.implementEndpoint(activityBarSaveEndpoint, {
    async [HttpMethod.Put]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await saveActivityBar(requestData),
            },
        };
    },
});

const foldersImplementation = implementor.implementEndpoint(foldersEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    folders: (await getCachedFolders()).map((folder) => {
                        return {
                            ...folder,
                            watchMode: getWatchModeInfo(folder.path),
                        };
                    }),
                    folderActivation: getFolderActivation(),
                    configRevision: await readConfigRevision(),
                    uiLayoutRevision: readUiLayoutRevision(),
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
        const aiId = requestData.aiId?.trim();
        if (aiId) {
            await updateConfig((config) => {
                return setFolderAiId({
                    config,
                    folder: worktreePath,
                    aiId,
                });
            });
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
        forgetFolderActivity(requestData.worktreePath);
        await deleteFolderState(requestData.worktreePath);
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
                    liveSessionIds: await mapEnumToObject(PaneKind, (kind) => {
                        return getLivePaneSessionIds(folder, kind);
                    }),
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
        /**
         * Kill the PTY and drop the cached daemon snapshot before removing the tab. The other order
         * leaves a window where the tab is gone but a snapshot still lists its PTY as live, and any
         * session-list request in that window has `reconcileFolderSessions` re-add it as an unnamed
         * tab. The check for whether the tab can close comes first because closing the last
         * remaining session is refused store-side, and killing its process while the tab stays
         * visible would leave the user looking at a dead terminal with no obvious way to revive
         * it.
         */
        if (
            isFolderSessionRemovable({
                sessions: await getFolderSessions(folder),
                kind: requestData.kind,
                sessionId: requestData.sessionId,
            })
        ) {
            await killPaneSession({
                folder,
                kind: requestData.kind,
                sessionId: requestData.sessionId,
            }).catch(() => {
                /* no live PTY for this session (never attached, or daemon restarted) */
            });
            invalidatePaneStatuses();
        }
        const {sessions} = await removeFolderSession({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId,
        });
        return {
            [HttpStatus.Ok]: {
                responseData: sessions,
            },
        };
    },
});

const sessionSetAiImplementation = implementor.implementEndpoint(sessionSetAiEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const folder = normalizePath(requestData.folder);
        const sessions = await setFolderSessionAi({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId,
            aiId: requestData.aiId,
        });
        const resolvedAis = paneKindRunsAi[requestData.kind]
            ? await Promise.all(
                  sessions[requestData.kind].map(async (session) => {
                      return {
                          sessionId: session.id,
                          aiId: (
                              await resolveAiForSession({
                                  folder,
                                  sessionId: session.id,
                              })
                          )?.id,
                      };
                  }),
              )
            : [];
        const switchedAiId = resolvedAis.find(
            (entry) => entry.sessionId === requestData.sessionId,
        )?.aiId;
        /**
         * Switching onto an AI another tab in this folder already runs is the same as adding a
         * second tab for it: resuming would open that other tab's conversation.
         */
        const isSharedAi =
            !!switchedAiId &&
            resolvedAis.some((entry) => {
                return entry.sessionId !== requestData.sessionId && entry.aiId === switchedAiId;
            });
        return {
            [HttpStatus.Ok]: {
                responseData: isSharedAi
                    ? await startNewConversation({
                          folder,
                          kind: requestData.kind,
                          sessionId: requestData.sessionId,
                      })
                    : sessions,
            },
        };
    },
});

const aiAvatarUploadImplementation = implementor.implementEndpoint(aiAvatarUploadEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    avatarFile: await saveAiAvatar(requestData),
                },
            },
        };
    },
});

const aiAvatarImplementation = implementor.implementEndpoint(aiAvatarEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await readAiAvatar(requestData.avatarFile),
            },
        };
    },
});

const restartPaneImplementation = implementor.implementEndpoint(restartPaneEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /**
         * Forward the tab's resolved resume command so a "Restart" picks up any recent change to
         * which AI it uses (the daemon caches nothing about config — every fresh spawn uses
         * whatever the backend hands it).
         */
        const folder = normalizePath(requestData.folder);
        const sessionId = await resolveSessionId({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId ?? undefined,
        });
        const launch = await resolvePaneLaunch({
            folder,
            kind: requestData.kind,
            sessionId,
        });
        await restartPane({
            folder,
            kind: requestData.kind,
            sessionId,
            aiCmd: launch.aiCmd,
            conversationId: launch.conversationId,
        });
        await launch.markStarted(true);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const paneInputImplementation = implementor.implementEndpoint(paneInputEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await sendPaneText(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

/** Switches every open frontend to the requested folder, then launches its session. */
async function launchRequestedSession({folder: requestedFolder, prompt}: Readonly<LaunchRequest>) {
    /** The requester usually just created this folder, so the cached listing may predate it. */
    await refreshFolderInfoNow();
    const folder = normalizePath(requestedFolder);
    const isKnownFolder = (await getCachedFolders()).some((info) => {
        return info.path === folder;
    });
    if (!isKnownFolder) {
        return `"${folder}" is not a folder agent-storm shows. Create it inside a repo agent-storm already lists, then retry.`;
    }
    /** Starting a fresh AI can take longer than the requester should wait for an answer. */
    launchFolderSession({
        folder,
        prompt,
    }).catch((error: unknown) => {
        log.error(`Failed to launch an AI session in "${folder}": ${String(error)}`);
    });
    return undefined;
}

const watchModeImplementation = implementor.implementEndpoint(watchModeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await setWatchMode(requestData);
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
         * "Kill panes" means all of them, so the tab lists go too — the folder should come back
         * with a clean single tab per kind rather than a row of tabs whose PTYs are all dead.
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
        await waitForDaemonGone({
            seconds: 3,
        });
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

/**
 * Updates the config entry of the repo that owns `folder`: the folder's parent repo when it's a
 * worktree, else the folder itself. Unknown folders (stale paths, freshly deleted worktrees, a race
 * against the folder-info refresh) and unreadable configs are no-ops, since callers only record
 * best-effort metadata.
 */
async function updateOwningRepoConfig({
    folder,
    update,
}: Readonly<{
    folder: string;
    update: (repo: Readonly<RepoConfig>) => RepoConfig;
}>) {
    const target = normalizePath(folder);
    const cached = (await getCachedFolders()).find((entry) => entry.path === target);
    const repoPath = cached?.parentRepoPath ?? cached?.path ?? target;
    await updateConfig((config) => {
        if (!config.repos.some((repo) => repo.path === repoPath)) {
            return undefined;
        }
        return {
            ...config,
            repos: config.repos.map((repo) => (repo.path === repoPath ? update(repo) : repo)),
        };
    });
}

const touchRepoImplementation = implementor.implementEndpoint(touchRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await updateOwningRepoConfig({
            folder: requestData.folder,
            update(repo) {
                return {
                    ...repo,
                    lastInteractedAtMs: Date.now(),
                };
            },
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

const closeEditorWindowImplementation = implementor.implementEndpoint(closeEditorWindowEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await closeReviewWindow(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const readReviewCommentsImplementation = implementor.implementEndpoint(readReviewCommentsEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    comments: await readReviewComments({
                        folder: requestData.folder,
                    }),
                },
            },
        };
    },
});

const addReviewCommentImplementation = implementor.implementEndpoint(addReviewCommentEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    comments: await addReviewComment(requestData),
                },
            },
        };
    },
});

const updateReviewCommentImplementation = implementor.implementEndpoint(
    updateReviewCommentEndpoint,
    {
        async [HttpMethod.Post]({requestData}) {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        comments: await updateReviewComment(requestData),
                    },
                },
            };
        },
    },
);

const deleteReviewCommentImplementation = implementor.implementEndpoint(
    deleteReviewCommentEndpoint,
    {
        async [HttpMethod.Post]({requestData}) {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        comments: await deleteReviewComment(requestData),
                    },
                },
            };
        },
    },
);

const hideRepoImplementation = implementor.implementEndpoint(hideRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /** The sidebar's recency filter treats a repo with no timestamp as hidden. */
        await updateOwningRepoConfig({
            folder: requestData.folder,
            update(repo) {
                return omitObjectKeys(repo, ['lastInteractedAtMs']);
            },
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

const gitDiscardUnstagedImplementation = implementor.implementEndpoint(gitDiscardUnstagedEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await discardUnstagedChanges(normalizePath(requestData.folder));
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

const gitHubReviewQueueImplementation = implementor.implementEndpoint(gitHubReviewQueueEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await readReviewQueue(),
            },
        };
    },
    async [HttpMethod.Post]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await refreshReviewQueue(),
            },
        };
    },
});

const gitHubAssigneeQueueImplementation = implementor.implementEndpoint(
    gitHubAssigneeQueueEndpoint,
    {
        async [HttpMethod.Get]() {
            return {
                [HttpStatus.Ok]: {
                    responseData: await readAssigneeQueue(),
                },
            };
        },
        async [HttpMethod.Post]() {
            return {
                [HttpStatus.Ok]: {
                    responseData: await refreshAssigneeQueue(),
                },
            };
        },
    },
);

const gitHubReviewFolderImplementation = implementor.implementEndpoint(gitHubReviewFolderEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await resolveReviewFolder(requestData),
            },
        };
    },
});

const reviewInitImplementation = implementor.implementEndpoint(reviewInitEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await runReviewInitCmd(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const gitHubReviewPrImplementation = implementor.implementEndpoint(gitHubReviewPrEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await readReviewPr(requestData),
            },
        };
    },
});

const manualReviewCopyImplementation = implementor.implementEndpoint(manualReviewCopyEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    folder: await findManualReviewCopy(normalizePath(requestData.folder)),
                },
            },
        };
    },
});

const manualReviewStateImplementation = implementor.implementEndpoint(manualReviewStateEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    review: await readManualReviewState(requestData),
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
         * Resolve which AI this tab runs on every attach so the daemon's spawned PTY (when this is
         * the first attach for the folder + kind pair) uses whatever the user has set. Failure is
         * non-fatal — the daemon falls back to its built-in default (`claude`).
         */
        const launch = await resolvePaneLaunch({
            folder,
            kind,
            sessionId,
        });
        const attachment = await attachPane({
            folder,
            kind,
            sessionId,
            colors: {
                foreground: searchParams.foreground,
                background: searchParams.background,
            },
            aiCmd: launch.aiCmd,
            conversationId: launch.conversationId,
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
        await launch.markStarted(attachment.isRunning);
        attachmentsByWebSocket.set(webSocket, {
            attachment,
            folder,
            kind,
            conversationId: paneKindRunsAi[kind] ? launch.conversationId : undefined,
        });
    },
    message({webSocket, message}) {
        const socketAttachment = attachmentsByWebSocket.get(webSocket);
        if (!socketAttachment) {
            return;
        } else if (typeof message === 'string') {
            /**
             * String frames are keystrokes (and pastes) from the user; binary frames are resizes,
             * which the browser sends on its own and so say nothing about the user being here.
             */
            recordFolderActivity(socketAttachment.folder);
            /** Escape and Ctrl+C on their own are how a Claude turn gets interrupted. */
            if (socketAttachment.conversationId && (message === '\u001B' || message === '\u0003')) {
                recordClaudeInterrupt(socketAttachment.conversationId);
            }
            socketAttachment.attachment.write(message);
            return;
        } else if ('colors' in message) {
            socketAttachment.attachment.setColors(message.colors);
            return;
        }
        socketAttachment.attachment.resize(message.resize);
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
            ? check.isString(requestHeaders['sec-websocket-protocol'])
                ? requestHeaders['sec-websocket-protocol'].trim()
                : undefined
            : extractBearerToken(requestHeaders.authorization);
        if (!(await verifyAuthToken(provided))) {
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
        reviewConfigImplementation,
        uiLayoutImplementation,
        tabLayoutSaveImplementation,
        activityBarSaveImplementation,
        foldersImplementation,
        updateCheckImplementation,
        createWorktreeImplementation,
        deleteWorktreeImplementation,
        restartPaneImplementation,
        killPanesImplementation,
        paneInputImplementation,
        watchModeImplementation,
        sessionListImplementation,
        sessionCreateImplementation,
        sessionRenameImplementation,
        sessionCloseImplementation,
        sessionSetAiImplementation,
        aiAvatarUploadImplementation,
        aiAvatarImplementation,
        clientErrorImplementation,
        restartDaemonImplementation,
        touchRepoImplementation,
        hideRepoImplementation,
        closeEditorWindowImplementation,
        readReviewCommentsImplementation,
        addReviewCommentImplementation,
        updateReviewCommentImplementation,
        deleteReviewCommentImplementation,
        checkPathImplementation,
        createPathImplementation,
        uploadImplementation,
        gitDiffStatusImplementation,
        gitDiffFileImplementation,
        gitStageFileImplementation,
        gitStageAllImplementation,
        gitStageHunkImplementation,
        gitDiscardFileImplementation,
        gitDiscardUnstagedImplementation,
        gitDiscardHunkImplementation,
        gitHubPrImplementation,
        gitHubCommentImplementation,
        gitHubReactionImplementation,
        gitHubResolveThreadImplementation,
        gitHubReviewQueueImplementation,
        gitHubAssigneeQueueImplementation,
        manualReviewStateImplementation,
        manualReviewCopyImplementation,
        gitHubReviewFolderImplementation,
        reviewInitImplementation,
        gitHubReviewPrImplementation,
    ],
    webSockets: [ptyImplementation],
});

/**
 * This server has to match whatever scheme the frontend is served over, because the browser builds
 * its URL from `location.protocol` (see `getBackendBaseUrl` in
 * `packages/frontend/src/util/service-origin.ts`). An http backend behind an https page fails every
 * request at the TLS handshake. `tlsCertPath` is the single switch for both, and the key is the
 * file of the same name beside the certificate — same convention as
 * `packages/frontend/configs/vite.config.ts`.
 */
async function readTlsOptions() {
    const certPath = await loadConfig()
        .then((config) => config.tlsCertPath || '')
        .catch(() => '');
    if (!certPath) {
        return undefined;
    }
    const keyPath = replaceExtension({
        path: certPath,
        newExtension: '.key',
    });
    try {
        return {
            cert: await readFile(certPath),
            key: await readFile(keyPath),
        };
    } catch (error) {
        log.warning(
            `Serving over http: failed to read TLS cert "${certPath}" / key "${keyPath}": ${String(error)}`,
        );
        return undefined;
    }
}

const tlsOptions = await readTlsOptions();

/**
 * Custom Fastify instance so we can raise `bodyLimit` past Fastify's 1 MB default. Image uploads
 * (screenshots dragged into a terminal) get base64-encoded inside a JSON body and that runs past
 * the default in a hurry.
 */
const server = fastify({
    bodyLimit: convertByteSize(
        {
            megabytes: 25,
        },
        {
            bytes: true,
        },
    ).bytes,
    ...(tlsOptions
        ? {
              https: tlsOptions,
          }
        : {}),
});
await attachApi(server, implementation, {
    externalOrigin: `${tlsOptions ? 'https' : 'http'}://localhost:${port}`,
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

await startLaunchRequestWatch(launchRequestedSession);

log.success(`agent-storm server listening on ${listenAddress}`);
