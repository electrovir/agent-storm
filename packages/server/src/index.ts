// cspell:words mkdirs

import {
    activityBarSaveEndpoint,
    addRepoEndpoint,
    agentStormService,
    checkPathEndpoint,
    clientDebugLogEndpoint,
    clientErrorEndpoint,
    clientFreezeEndpoint,
    clientPerfEndpoint,
    createPathEndpoint,
    foldersEndpoint,
    folderSettingsApprovalEndpoint,
    folderSettingsEndpoint,
    hideRepoEndpoint,
    installUpdateEndpoint,
    notificationsWebSocket,
    onboardingEndpoint,
    paneInputEndpoint,
    PaneKind,
    pluginCallEndpoint,
    pluginCodeEndpoint,
    pluginDecisionEndpoint,
    pluginEventsHeartbeatEvent,
    pluginEventsHeartbeatInterval,
    pluginEventsWebSocket,
    pluginsEndpoint,
    ptyWebSocket,
    pushKeyEndpoint,
    pushSubscribeEndpoint,
    pushTestEndpoint,
    pushUnsubscribeEndpoint,
    rememberedSelectionSaveEndpoint,
    removeRepoEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    sessionRenameEndpoint,
    settingsEndpoint,
    startAtLoginEndpoint,
    switchUpdateEndpoint,
    tabLayoutSaveEndpoint,
    touchRepoEndpoint,
    uiLayoutEndpoint,
    updateCheckEndpoint,
    userInputEndpoint,
    type SavedRepo,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    convertByteSize,
    extractErrorMessage,
    HttpMethod,
    HttpStatus,
    log,
    mapEnumToObject,
    omitObjectKeys,
} from '@augment-vir/common';
import fastifyStatic from '@fastify/static';
import {type OriginRequirement, type WebSocketHostMessageType} from '@rest-vir/api';
import {attachApi, createApiImplementor, implementApi, silentServerLogger} from '@rest-vir/host';
import {defaultPorts, PortEnvVar, readEnvPort} from 'agent-storm';
import {manualReviewSkillDir, normalizePath} from 'agent-storm-util';
import {getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import fastify, {type FastifyInstance} from 'fastify';
import {appendFileSync, renameSync, statSync} from 'node:fs';
import {appendFile, mkdir, stat} from 'node:fs/promises';
import {parseUrl} from 'url-vir';
import {loadAppState, updateAppState} from './app-state.js';
import {extractBearerToken, initAuth, verifyAuthToken} from './auth.js';
import {startConfigBackupLoop} from './config-backup.js';
import {
    attachPane,
    killLegacyPanes,
    killPaneSession,
    restartPane,
    shutdownDaemon,
    type PaneAttachment,
} from './daemon/daemon-client.js';
import {ensureDaemon, waitForDaemonGone} from './daemon/ensure-daemon.js';
import {
    appendDebugLog,
    logPluginCallDebug,
    pruneDebugLogs,
    startGhCallDebugLog,
    startRequestDebugLog,
} from './debug-log.js';
import {
    clientErrorLogPath,
    failedPaneInputsPath,
    folderActivityPath,
    legacyFolderActivityPath,
    legacyReviewsDir,
    legacySessionStorePath,
    releaseFrontendDir,
    serverLogPath,
    sessionStorePath,
} from './file-paths.js';
import {loadFolderActivity, recordFolderActivity} from './folder-activity.js';
import {getCachedFolders, refreshFolderInfoNow, startFolderInfoRefreshLoop} from './folder-info.js';
import {
    loadFolderSettingsApprovals,
    readFolderSettingsFiles,
    saveFolderSettingsApproval,
} from './folder-settings.js';
import {startLivePaneTracking} from './live-panes.js';
import {migrateBuildPluginId} from './migrate-build-plugin-id.js';
import {migrateReviewFolders} from './migrate-review-folders.js';
import {
    addPushSubscription,
    readVapidKeys,
    removeNotificationSocket,
    removePushSubscriptions,
    sendDismissedNotifications,
    sendSavedNotifications,
    sendTestPush,
    setNotificationSocket,
} from './notifications.js';
import {finishOnboarding, readOnboardingStatus, setStartAtLogin} from './onboarding.js';
import {sendPaneText} from './pane-launch.js';
import {appendPerfLog, logServerStartup, startServerPerfLog} from './perf-log.js';
import {readPluginWatchMode} from './plugin-folder-hooks.js';
import {callPluginServer, startPluginServers} from './plugin-servers.js';
import {
    readActivePluginCode,
    readPlugins,
    readPluginsRevision,
    savePluginDecision,
} from './plugins.js';
import {getLivePaneSessionIds, invalidatePaneStatuses} from './pty.js';
import {launcherOriginEnvVar, releaseBuild} from './release-build.js';
import {
    createFolderSession,
    findOrCreateFirstSession,
    reconcileFolderSessions,
    removeFolderSession,
    renameFolderSession,
    resolveSessionId,
} from './sessions.js';
import {migrateLegacyConfigFiles} from './settings-migration.js';
import {loadSettings, readSettingsRevision, saveSettings} from './settings.js';
import {readTlsOptions} from './tls-options.js';
import {
    loadUiLayout,
    pruneFolderStates,
    readUiLayoutRevision,
    saveActivityBar,
    saveRememberedSelection,
    saveTabLayout,
} from './ui-layout.js';
import {getUpdateStatus, startUpdateInstall, switchToPreparedUpdate} from './update-check.js';
import {recordUserInput} from './user-input.js';

/** Past this size the server log is moved to a `.old` copy, so a long session can't fill the disk. */
const maxServerLogBytes = 20_000_000;

/**
 * Mirror stdout/stderr to `serverLogPath` so the assistant can tail the backend output instead of
 * asking the user to copy/paste console lines. Each start appends after a marker line rather than
 * truncating: `npm start` restarts the server on every file change, which would erase the run being
 * debugged. The original streams keep going to the terminal — we just `appendFileSync` a
 * timestamped copy of each chunk. Wrapped in try/catch so a transient FS error never crashes the
 * backend.
 */
try {
    if (
        (statSync(serverLogPath, {
            throwIfNoEntry: false,
        })?.size || 0) > maxServerLogBytes
    ) {
        renameSync(serverLogPath, `${serverLogPath}.old`);
    }
    appendFileSync(
        serverLogPath,
        `\n=== server started ${toUtcIsoString(getNowInUtcTimezone())} ===\n`,
    );
} catch {
    /* ignore log rotation errors */
}
function mirrorWriteTo<Stream extends NodeJS.WriteStream>(
    original: Stream['write'],
    stream: Stream,
): Stream['write'] {
    return ((chunk: unknown, ...rest: unknown[]) => {
        try {
            if (check.isString(chunk) || chunk instanceof Buffer) {
                appendFileSync(
                    serverLogPath,
                    `[${toUtcIsoString(getNowInUtcTimezone())}] ${check.isString(chunk) ? chunk : chunk.toString()}`,
                );
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
};

const attachmentsByWebSocket = new WeakMap<object, SocketAttachment>();

await migrateLegacyConfigFiles();

await migrateReviewFolders({
    /**
     * Stays in the app rather than the review plugin: it renames the keys of the pane sessions and
     * folder activity files, so it has to finish before those load below.
     */
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
await migrateBuildPluginId();
void pruneFolderStates();

await ensureDaemon();
await killLegacyPanes().catch((error: unknown) => {
    log.warning(
        `Stopping the AI tabs an earlier release left running failed, so they run until the PTY daemon restarts: ${extractErrorMessage(error)}`,
    );
});

await loadFolderActivity();

await startFolderInfoRefreshLoop();

startConfigBackupLoop();

await initAuth();

await startPluginServers((message) => {
    pluginEventSockets.forEach((socket) => socket.send(message));
});

setInterval(() => {
    pluginEventSockets.forEach((socket) => {
        socket.send({
            pluginId: '',
            event: pluginEventsHeartbeatEvent,
            data: {},
        });
    });
}, pluginEventsHeartbeatInterval.milliseconds);

const implementor = createApiImplementor<undefined>()(agentStormService);

const settingsImplementation = implementor.implementEndpoint(settingsEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await loadSettings(),
            },
        };
    },
    async [HttpMethod.Put]({requestData}) {
        await saveSettings(requestData);
        const settings = await loadSettings();
        /** A changed setting has to reach `/folders` before the frontend's next poll. */
        await refreshFolderInfoNow();
        return {
            [HttpStatus.Ok]: {
                responseData: settings,
            },
        };
    },
});

const folderSettingsImplementation = implementor.implementEndpoint(folderSettingsEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const files = await readFolderSettingsFiles({
            folder: normalizePath(requestData.folder),
            approvals: await loadFolderSettingsApprovals(),
        });
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    files: files.map((file) => {
                        return {
                            path: file.path,
                            contents: file.text,
                            contentHash: file.contentHash,
                            approval: file.approval,
                            problem: file.problem,
                        };
                    }),
                },
            },
        };
    },
});

const folderSettingsApprovalImplementation = implementor.implementEndpoint(
    folderSettingsApprovalEndpoint,
    {
        async [HttpMethod.Put]({requestData}) {
            await saveFolderSettingsApproval(requestData);
            /** Approved commands and AIs have to reach `/folders` before the frontend's next poll. */
            await refreshFolderInfoNow();
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

const pluginsImplementation = implementor.implementEndpoint(pluginsEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await readPlugins(),
            },
        };
    },
});

const pluginDecisionImplementation = implementor.implementEndpoint(pluginDecisionEndpoint, {
    async [HttpMethod.Put]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await savePluginDecision(requestData),
            },
        };
    },
});

const pluginCodeImplementation = implementor.implementEndpoint(pluginCodeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: await readActivePluginCode(requestData.pluginId),
            },
        };
    },
});

const pluginCallImplementation = implementor.implementEndpoint(pluginCallEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const startedAt = Date.now();
        try {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        response: await callPluginServer(requestData),
                    },
                },
            };
        } catch (error) {
            return {
                [HttpStatus.Ok]: {
                    responseData: {
                        errorMessage: extractErrorMessage(error),
                    },
                },
            };
        } finally {
            await logPluginCallDebug({
                pluginId: requestData.pluginId,
                call: requestData.call,
                startedAt,
            });
        }
    },
});

/** Every open plugin events socket, which each plugin event goes to. */
const pluginEventSockets = new Set<{
    send(message: WebSocketHostMessageType<typeof pluginEventsWebSocket>): void;
}>();

const pluginEventsImplementation = implementor.implementWebSocket(pluginEventsWebSocket, {
    open({webSocket}) {
        pluginEventSockets.add(webSocket);
    },
    close({webSocket}) {
        pluginEventSockets.delete(webSocket);
    },
});

const notificationsImplementation = implementor.implementWebSocket(notificationsWebSocket, {
    async open({webSocket}) {
        setNotificationSocket(webSocket, {
            isActive: false,
            paths: [],
        });
        await sendSavedNotifications(webSocket);
    },
    async message({webSocket, message}) {
        if ('dismissedIds' in message) {
            await sendDismissedNotifications({
                socket: webSocket,
                dismissedIds: message.dismissedIds,
            });
        } else {
            setNotificationSocket(webSocket, message);
        }
    },
    close({webSocket}) {
        removeNotificationSocket(webSocket);
    },
});

const pushKeyImplementation = implementor.implementEndpoint(pushKeyEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    publicKey: (await readVapidKeys()).publicKey,
                },
            },
        };
    },
});

const pushSubscribeImplementation = implementor.implementEndpoint(pushSubscribeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await addPushSubscription(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const pushUnsubscribeImplementation = implementor.implementEndpoint(pushUnsubscribeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await removePushSubscriptions([
            requestData.endpoint,
        ]);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const pushTestImplementation = implementor.implementEndpoint(pushTestEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    errorMessage: await sendTestPush(requestData.endpoint),
                },
            },
        };
    },
});

const addRepoImplementation = implementor.implementEndpoint(addRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const path = normalizePath(requestData.path);
        const isNew = !(await loadAppState()).repos.some((repo) => repo.path === path);
        /** Re-adding a saved repo stamps it as used, so the hide-inactive filter shows it again. */
        await updateAppState((state) => {
            return {
                ...state,
                repos: [
                    ...state.repos.filter((repo) => repo.path !== path),
                    {
                        path,
                        lastInteractedAtMs: Date.now(),
                    },
                ],
            };
        });
        /**
         * Re-enumerate folder targets now so the new repo shows up in `/folders` immediately
         * instead of waiting for the next background sweep (git/PR fields fill in over the next
         * sweep).
         */
        await refreshFolderInfoNow();
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    repos: (await loadAppState()).repos,
                    isNew,
                },
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

const rememberedSelectionSaveImplementation = implementor.implementEndpoint(
    rememberedSelectionSaveEndpoint,
    {
        async [HttpMethod.Put]({requestData}) {
            return {
                [HttpStatus.Ok]: {
                    responseData: await saveRememberedSelection(requestData),
                },
            };
        },
    },
);

const foldersImplementation = implementor.implementEndpoint(foldersEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    folders: (await getCachedFolders()).map((folder) => {
                        return {
                            ...folder,
                            watchMode: readPluginWatchMode({
                                folder: folder.path,
                                fallback: folder.watchMode,
                            }),
                        };
                    }),
                    settingsRevision: await readSettingsRevision(),
                    repos: (await loadAppState()).repos,
                    uiLayoutRevision: readUiLayoutRevision(),
                    pluginsRevision: await readPluginsRevision(),
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

const installUpdateImplementation = implementor.implementEndpoint(installUpdateEndpoint, {
    async [HttpMethod.Post]() {
        await startUpdateInstall();
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const switchUpdateImplementation = implementor.implementEndpoint(switchUpdateEndpoint, {
    async [HttpMethod.Post]() {
        await switchToPreparedUpdate();
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const onboardingImplementation = implementor.implementEndpoint(onboardingEndpoint, {
    async [HttpMethod.Get]() {
        return {
            [HttpStatus.Ok]: {
                responseData: await readOnboardingStatus(),
            },
        };
    },
    async [HttpMethod.Post]() {
        await finishOnboarding();
        return {
            [HttpStatus.Ok]: {
                responseData: await readOnboardingStatus(),
            },
        };
    },
});

const startAtLoginImplementation = implementor.implementEndpoint(startAtLoginEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await setStartAtLogin(requestData.isEnabled);
        return {
            [HttpStatus.Ok]: {
                responseData: await readOnboardingStatus(),
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
                    scope: requestData.scope,
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
         * tab.
         */
        await killPaneSession({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId,
        }).catch(() => {
            /* no live PTY for this session (never attached, or daemon restarted) */
        });
        invalidatePaneStatuses();
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

const restartPaneImplementation = implementor.implementEndpoint(restartPaneEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const folder = normalizePath(requestData.folder);
        const sessionId = await resolveSessionId({
            folder,
            kind: requestData.kind,
            sessionId: requestData.sessionId ?? undefined,
        });
        await restartPane({
            folder,
            kind: requestData.kind,
            sessionId,
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

const paneInputImplementation = implementor.implementEndpoint(paneInputEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        try {
            await sendPaneText({
                ...requestData,
                sessionId:
                    requestData.sessionId ||
                    (await findOrCreateFirstSession({
                        folder: requestData.folder,
                        kind: requestData.kind,
                    })),
            });
        } catch (error) {
            await appendFile(
                failedPaneInputsPath,
                `${JSON.stringify({
                    at: toUtcIsoString(getNowInUtcTimezone()),
                    error: extractErrorMessage(error),
                    ...requestData,
                })}\n`,
            ).catch(() => {
                /* ignore append errors */
            });
            throw error;
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

const clientFreezeImplementation = implementor.implementEndpoint(clientFreezeEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await appendPerfLog({
            side: 'client',
            event: 'freeze',
            ...requestData,
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

const clientDebugLogImplementation = implementor.implementEndpoint(clientDebugLogEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await appendDebugLog(requestData);
        return {
            [HttpStatus.Ok]: {
                responseData: {
                    ok: true,
                },
            },
        };
    },
});

const clientPerfImplementation = implementor.implementEndpoint(clientPerfEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await appendPerfLog({
            side: 'client',
            event: 'window',
            ...requestData,
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

const userInputImplementation = implementor.implementEndpoint(userInputEndpoint, {
    async [HttpMethod.Post]() {
        await recordUserInput();
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
 * Updates the saved entry of the repo that owns `folder`: the folder's parent repo when it's a
 * worktree, else the folder itself. Unknown folders (stale paths, freshly deleted worktrees, a race
 * against the folder-info refresh) and an unreadable state are no-ops, since callers only record
 * best-effort metadata.
 */
async function updateOwningRepo({
    folder,
    update,
}: Readonly<{
    folder: string;
    update: (repo: Readonly<SavedRepo>) => SavedRepo;
}>) {
    const target = normalizePath(folder);
    const cached = (await getCachedFolders()).find((entry) => entry.path === target);
    const repoPath = cached?.parentRepoPath ?? cached?.path ?? target;
    await updateAppState((state) => {
        if (!state.repos.some((repo) => repo.path === repoPath)) {
            return undefined;
        }
        return {
            ...state,
            repos: state.repos.map((repo) => (repo.path === repoPath ? update(repo) : repo)),
        };
    });
}

const touchRepoImplementation = implementor.implementEndpoint(touchRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        await updateOwningRepo({
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

const hideRepoImplementation = implementor.implementEndpoint(hideRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        /** The sidebar's recency filter treats a repo with no timestamp as hidden. */
        await updateOwningRepo({
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

const removeRepoImplementation = implementor.implementEndpoint(removeRepoEndpoint, {
    async [HttpMethod.Post]({requestData}) {
        const folder = normalizePath(requestData.folder);
        await updateAppState((state) => {
            if (!state.repos.some((repo) => repo.path === folder)) {
                return undefined;
            }
            return {
                ...state,
                repos: state.repos.filter((repo) => repo.path !== folder),
            };
        });
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
        const attachment = await attachPane({
            folder,
            kind,
            sessionId,
            colors: {
                foreground: searchParams.foreground,
                background: searchParams.background,
            },
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
            /**
             * String frames are keystrokes (and pastes) from the user; binary frames are resizes,
             * which the browser sends on its own and so say nothing about the user being here.
             */
            recordFolderActivity(socketAttachment.folder);
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
        settingsImplementation,
        folderSettingsImplementation,
        folderSettingsApprovalImplementation,
        pluginsImplementation,
        pluginDecisionImplementation,
        pluginCodeImplementation,
        pluginCallImplementation,
        addRepoImplementation,
        uiLayoutImplementation,
        tabLayoutSaveImplementation,
        activityBarSaveImplementation,
        rememberedSelectionSaveImplementation,
        foldersImplementation,
        updateCheckImplementation,
        installUpdateImplementation,
        switchUpdateImplementation,
        onboardingImplementation,
        startAtLoginImplementation,
        restartPaneImplementation,
        paneInputImplementation,
        sessionListImplementation,
        sessionCreateImplementation,
        sessionRenameImplementation,
        sessionCloseImplementation,
        clientErrorImplementation,
        clientDebugLogImplementation,
        clientPerfImplementation,
        clientFreezeImplementation,
        restartDaemonImplementation,
        userInputImplementation,
        touchRepoImplementation,
        hideRepoImplementation,
        removeRepoImplementation,
        checkPathImplementation,
        createPathImplementation,
        pushKeyImplementation,
        pushSubscribeImplementation,
        pushUnsubscribeImplementation,
        pushTestImplementation,
    ],
    webSockets: [
        ptyImplementation,
        pluginEventsImplementation,
        notificationsImplementation,
    ],
});

/** Set when a release's launcher started this server, to the origin the launcher serves. */
const launcherOrigin = process.env[launcherOriginEnvVar] || undefined;

/** Behind the launcher, the browser's TLS ends at the launcher, which owns the public port. */
const tlsOptions = launcherOrigin ? undefined : await readTlsOptions();

/**
 * Custom Fastify instance so we can raise `bodyLimit` past Fastify's 1 MB default. Image uploads
 * (screenshots dragged into a terminal) get base64-encoded inside a JSON body and that runs past
 * the default in a hurry.
 */
const serverOptions = {
    bodyLimit: convertByteSize(
        {
            megabytes: 25,
        },
        {
            bytes: true,
        },
    ).bytes,
};
/**
 * HTTP/2 over TLS because browsers cap HTTP/1.1 at six connections per origin: over a slow link (a
 * phone on Tailscale) the app's polls queue behind each other for seconds. `allowHTTP1` keeps
 * WebSockets working, since browsers open those over HTTP/1.1. The cast is because `@rest-vir/host`
 * only types the HTTP/1 server; it runs fine on fastify's HTTP/2 request and reply.
 */
const server = tlsOptions
    ? (fastify({
          ...serverOptions,
          http2: true,
          https: {
              ...tlsOptions,
              allowHTTP1: true,
          },
      }) satisfies FastifyInstance<any, any, any> as FastifyInstance)
    : fastify(serverOptions);
startServerPerfLog(server);
startRequestDebugLog(server);
await attachApi(server, implementation, {
    externalOrigin: launcherOrigin || `${tlsOptions ? 'https' : 'http'}://localhost:${port}`,
});
if (releaseBuild) {
    await server.register(fastifyStatic, {
        root: releaseFrontendDir,
    });
    /** The frontend routes by URL path, so every page load gets the app itself. */
    server.setNotFoundHandler(async (request, reply) => {
        if (request.method !== 'GET') {
            return await reply.code(HttpStatus.NotFound).send();
        }
        return await reply.sendFile('index.html');
    });
}
/**
 * Bind to `0.0.0.0` so the dev server is reachable over LAN (testing the UI from a phone or another
 * laptop after running the vite frontend with `--host`). The auth-secret check in
 * `createHostContext` is what actually keeps a LAN attacker out — the bind alone is just a
 * reachability concern. Behind the launcher, only the launcher needs to reach this server.
 */
const listenAddress = await server.listen({
    port,
    host: launcherOrigin ? '127.0.0.1' : '0.0.0.0',
});

/** Resuming every tab can take a while, and the server is already usable without them. */
startLivePaneTracking().catch((error: unknown) => {
    log.warning(`Failed to restore tabs: ${extractErrorMessage(error)}`);
});
await logServerStartup();
startGhCallDebugLog();
await pruneDebugLogs();

log.success(`Agent Storm server listening on ${listenAddress}`);
