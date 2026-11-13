import {type PluginServerHost} from '@agent-storm/core/server';
import {tryGit} from 'agent-storm-util';

function throwUnmocked(): never {
    throw new Error('Not available in the test host.');
}

/**
 * A host for tests that reads a folder's branch and `origin` straight from git and throws from
 * everything else.
 */
export const testReviewHost: PluginServerHost = {
    loadSettings: throwUnmocked,
    loadFolderSettings: throwUnmocked,
    listFolders: throwUnmocked,
    listenToNewFolderPrs: throwUnmocked,
    recordFolderPrStatus: throwUnmocked,
    readBranchPrStatus: throwUnmocked,
    recordBranchPr: throwUnmocked,
    readOpenPrChangeKey: throwUnmocked,
    readGitHubPause: throwUnmocked,
    pauseGitHubForRateLimit: throwUnmocked,
    listPaneFolders: throwUnmocked,
    killFolderPanes: throwUnmocked,
    getPaneStatusLookup: throwUnmocked,
    getPaneSessionStatusLookup: throwUnmocked,
    getLivePaneSessionIds: throwUnmocked,
    deleteFolderState: throwUnmocked,
    getFolderSessions: throwUnmocked,
    createFolderSession: throwUnmocked,
    findFolderSession: throwUnmocked,
    renameFolderSession: throwUnmocked,
    createWorktree: throwUnmocked,
    isClaudeReady: throwUnmocked,
    isClaudeAwaitingPermission: throwUnmocked,
    spawnPane: throwUnmocked,
    sendPaneText: throwUnmocked,
    launchFolderSession: throwUnmocked,
    runInIdleFolderShell: throwUnmocked,
    async getCurrentBranch(folder) {
        return (
            (
                await tryGit(folder, [
                    'branch',
                    '--show-current',
                ])
            )?.trim() || null
        );
    },
    async getRepoSlug(folder) {
        const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
            (
                await tryGit(folder, [
                    'remote',
                    'get-url',
                    'origin',
                ])
            )?.trim() || '',
        );
        return match?.[1] && match[2]
            ? {
                  owner: match[1],
                  name: match[2],
              }
            : null;
    },
    listenToGitInfoChanges: throwUnmocked,
};
