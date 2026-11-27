import {type PluginServerHost} from '@agent-storm/core/server';
import {wait} from '@augment-vir/common';
import {normalizePath, tracePerfSpan} from 'agent-storm-util';
import {dirname} from 'node:path';
import {readBranchPrStatus} from './branch-prs.js';
import {
    attachHostedProcess,
    fetchPaneStatuses,
    killFolderPanes,
    killHostedProcess,
    listHostedProcessIds,
} from './daemon/daemon-client.js';
import {appCheckoutPath} from './file-paths.js';
import {forgetFolderActivity} from './folder-activity.js';
import {
    getCachedFolders,
    holdFolderPrStatus,
    listenToFolderPrChanges,
    listenToNewFolderPrs,
    pauseGitHubForRateLimit,
    readGitHubPause,
    recordFolderPrStatus,
    recordFoldersBranchPr,
    refreshFolderInfoNow,
} from './folder-info.js';
import {loadFolderSettings} from './folder-settings.js';
import {
    addWorktree,
    getCurrentBranch,
    getRepoSlug,
    isWorktreeRoot,
    listenToGitInfoChanges,
    removeWorktree,
} from './git.js';
import {sendNotification} from './notifications.js';
import {runInIdleFolderShell, runPostWorktreeCmd, sendPaneText, spawnPane} from './pane-launch.js';
import {isFolderBusyInPlugins} from './plugin-folder-hooks.js';
import {getLivePaneSessionIds, getPaneSessionStatusLookup} from './pty.js';
import {
    createFolderSession,
    findFolderSession,
    forgetFolderSessions,
    getFolderSessions,
    renameFolderSession,
    scopeFolderSessions,
} from './sessions.js';
import {loadSettings} from './settings.js';
import {deleteFolderState, moveFolderState} from './ui-layout.js';
import {listenToUserInput, readLastUserInputAt} from './user-input.js';

/** What every plugin's server part reaches the app's own state through. */
export const pluginServerHost: PluginServerHost = {
    loadSettings,
    loadFolderSettings,
    listFolders: getCachedFolders,
    listenToNewFolderPrs,
    listenToFolderPrChanges,
    recordFolderPrStatus,
    readBranchPrStatus,
    holdPrStatus: holdFolderPrStatus,
    recordBranchPr: recordFoldersBranchPr,
    isFolderBusyInPlugins,
    readGitHubPause,
    pauseGitHubForRateLimit,
    attachHostedProcess,
    listHostedProcessIds,
    killHostedProcess,
    async listPaneFolders() {
        return (await fetchPaneStatuses()).map((pane) => pane.folder);
    },
    killFolderPanes,
    getPaneSessionStatusLookup,
    getLivePaneSessionIds,
    deleteFolderState,
    async moveFolderPaneGroup(params) {
        /** First, so the sessions are in the scope by the time a window sees the moved layout. */
        await scopeFolderSessions(params);
        await moveFolderState(params);
    },
    getFolderSessions,
    createFolderSession,
    findFolderSession,
    renameFolderSession,
    spawnPane,
    sendPaneText,
    runInIdleFolderShell,
    getCurrentBranch,
    getRepoSlug,
    listenToGitInfoChanges,
    notify: sendNotification,
    findAppCheckoutPath() {
        return appCheckoutPath;
    },
    readLastUserInputAt,
    listenToUserInput,
    async createWorktree({folder, name, scope}) {
        const normalizedFolder = normalizePath(folder);
        const isRoot = await isWorktreeRoot(normalizedFolder);
        const repoPath = isRoot
            ? normalizedFolder
            : (await getCachedFolders()).find((info) => info.path === normalizedFolder)
                  ?.parentRepoPath || dirname(normalizedFolder);
        const {worktreePath} = await addWorktree({
            repoPath,
            name,
            baseCheckout: isRoot ? undefined : normalizedFolder,
        });
        await tracePerfSpan('refresh folder info', refreshFolderInfoNow);
        await tracePerfSpan('post-worktree command', async () => {
            await runPostWorktreeCmd({
                repoPath,
                worktreePath,
                scope,
            });
        });
        return {
            worktreePath,
        };
    },
    async deleteWorktree({worktreePath}) {
        await killFolderPanes({
            folder: worktreePath,
        }).catch(() => {
            /* if the daemon has no live panes for this folder, continue with deletion */
        });
        await tracePerfSpan('wait after killing panes', async () => {
            await wait({
                milliseconds: 250,
            });
        });
        await removeWorktree({
            worktreePath,
        });
        /**
         * Drop the folder's session tabs now that the folder is gone. Worktree paths are derived
         * deterministically from the worktree name, so leaving them behind means a later worktree
         * created with the same name inherits this one's named, PTY-less tabs.
         */
        await forgetFolderSessions(worktreePath);
        forgetFolderActivity(worktreePath);
        await deleteFolderState(worktreePath);
        await tracePerfSpan('refresh folder info', refreshFolderInfoNow);
    },
};
