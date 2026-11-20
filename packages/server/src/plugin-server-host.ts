import {type PluginServerHost} from '@agent-storm/core/server';
import {wait} from '@augment-vir/common';
import {normalizePath} from 'agent-storm-util';
import {dirname} from 'node:path';
import {readBranchPrStatus} from './branch-prs.js';
import {isClaudeAwaitingPermission, isClaudeReady} from './claude-activity.js';
import {
    attachHostedProcess,
    fetchPaneStatuses,
    killFolderPanes,
    killHostedProcess,
    listHostedProcessIds,
} from './daemon/daemon-client.js';
import {forgetFolderActivity} from './folder-activity.js';
import {
    getCachedFolders,
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
import {
    launchFolderSession,
    runInIdleFolderShell,
    runPostWorktreeCmd,
    sendPaneText,
    spawnPane,
} from './pane-launch.js';
import {isFolderBusyInPlugins} from './plugin-folder-hooks.js';
import {getLivePaneSessionIds, getPaneSessionStatusLookup, getPaneStatusLookup} from './pty.js';
import {
    createFolderSession,
    findFolderSession,
    forgetFolderSessions,
    getFolderSessions,
    renameFolderSession,
} from './sessions.js';
import {loadSettings} from './settings.js';
import {deleteFolderState} from './ui-layout.js';

/** What every plugin's server part reaches the app's own state through. */
export const pluginServerHost: PluginServerHost = {
    loadSettings,
    loadFolderSettings,
    listFolders: getCachedFolders,
    listenToNewFolderPrs,
    recordFolderPrStatus,
    readBranchPrStatus,
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
    getPaneStatusLookup,
    getPaneSessionStatusLookup,
    getLivePaneSessionIds,
    deleteFolderState,
    getFolderSessions,
    createFolderSession,
    findFolderSession,
    renameFolderSession,
    isClaudeReady,
    isClaudeAwaitingPermission,
    spawnPane,
    sendPaneText,
    launchFolderSession,
    runInIdleFolderShell,
    getCurrentBranch,
    getRepoSlug,
    listenToGitInfoChanges,
    async createWorktree({folder, name}) {
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
        await refreshFolderInfoNow();
        await runPostWorktreeCmd({
            repoPath,
            worktreePath,
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
        await wait({
            milliseconds: 250,
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
        await refreshFolderInfoNow();
    },
};
