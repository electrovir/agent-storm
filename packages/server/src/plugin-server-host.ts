import {type PluginServerHost} from '@agent-storm/core/server';
import {normalizePath} from 'agent-storm-util';
import {dirname} from 'node:path';
import {readBranchPrStatus, recordBranchPr} from './branch-prs.js';
import {isClaudeAwaitingPermission, isClaudeReady} from './claude-activity.js';
import {fetchPaneStatuses, killFolderPanes} from './daemon/daemon-client.js';
import {
    getCachedFolders,
    listenToNewFolderPrs,
    pauseGitHubForRateLimit,
    readGitHubPause,
    readOpenPrChangeKey,
    recordFolderPrStatus,
    refreshFolderInfoNow,
} from './folder-info.js';
import {loadFolderSettings} from './folder-settings.js';
import {addWorktree, getCurrentBranch, getRepoSlug, listenToGitInfoChanges} from './git.js';
import {
    launchFolderSession,
    runInIdleFolderShell,
    runPostWorktreeCmd,
    sendPaneText,
    spawnPane,
} from './pane-launch.js';
import {getLivePaneSessionIds, getPaneSessionStatusLookup, getPaneStatusLookup} from './pty.js';
import {
    createFolderSession,
    findFolderSession,
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
    recordBranchPr,
    readOpenPrChangeKey,
    readGitHubPause,
    pauseGitHubForRateLimit,
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
        const baseCheckout = normalizePath(folder);
        const repoPath =
            (await getCachedFolders()).find((info) => info.path === baseCheckout)?.parentRepoPath ||
            dirname(baseCheckout);
        const {worktreePath} = await addWorktree({
            repoPath,
            name,
            baseCheckout,
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
};
