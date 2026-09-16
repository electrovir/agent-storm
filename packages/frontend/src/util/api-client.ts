// cspell:word unstages

import {
    agentStormService,
    aiAvatarEndpoint,
    aiAvatarUploadEndpoint,
    checkPathEndpoint,
    clientErrorEndpoint,
    configEndpoint,
    createPathEndpoint,
    createWorktreeEndpoint,
    deleteWorktreeEndpoint,
    foldersEndpoint,
    gitDiffFileEndpoint,
    gitDiffStatusEndpoint,
    gitDiscardFileEndpoint,
    gitDiscardHunkEndpoint,
    gitDiscardUnstagedEndpoint,
    gitHubCommentEndpoint,
    gitHubPrEndpoint,
    gitHubReactionEndpoint,
    gitHubResolveThreadEndpoint,
    gitStageAllEndpoint,
    gitStageFileEndpoint,
    gitStageHunkEndpoint,
    hideRepoEndpoint,
    killPanesEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    sessionCloseEndpoint,
    sessionCreateEndpoint,
    sessionListEndpoint,
    sessionRenameEndpoint,
    sessionSetAiEndpoint,
    touchRepoEndpoint,
    updateCheckEndpoint,
    uploadEndpoint,
    type Config,
    type FolderInfo,
    type FolderSessions,
    type GitDiffFileContents,
    type GitDiffSide,
    type GitDiffStatus,
    type GitHubCommentTarget,
    type GitHubPr,
    type GitHubReaction,
    type PaneKind,
    type UpdateStatus,
} from '@agent-storm/common';
import {HttpStatus} from '@augment-vir/common';
import {RestVirClient, type ClientFetch, type EndpointFetchOutput} from '@rest-vir/api';
import {clearStoredSecret, ensureSecret} from './auth.js';
import {notifyBackendFailure, notifyBackendSuccess} from './backend-watchdog.js';
import {getBackendBaseUrl} from './service-origin.js';

/**
 * Inject the bearer secret on every request. The browser can't read a static header into the
 * rest-vir client, so we wrap `fetch`: each call resolves the current secret and sets the
 * `Authorization` header before delegating to the real `fetch`.
 */
const authFetch: ClientFetch = async (url, requestInit) => {
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${await ensureSecret()}`);
    return await fetch(url, {
        ...requestInit,
        headers,
    });
};

/**
 * Shared rest-vir client. `baseUrl` is the page-derived backend origin; `authFetch` adds the bearer
 * header to every request. Exposed so the terminal element can open the `/pty` WebSocket through
 * the same client (and thus the same base URL derivation).
 */
export const client = new RestVirClient(agentStormService, getBackendBaseUrl(), authFetch);

/**
 * Run a client fetch, fold the rest-vir status-keyed result into a "return data or throw" shape,
 * and keep the backend watchdog informed:
 *
 * - A thrown error means the fetch itself rejected (DNS / connection refused / abort — the backend
 *   process is gone). Count it toward the watchdog's recovery threshold and rethrow.
 * - An `Ok` result returns its `responseData`.
 * - Anything else means the server answered with an error (every endpoint declares only `Ok`, so a
 *   non-200 surfaces as `unexpectedError`): the backend is alive (notify success), a `401` clears
 *   the stored secret, and we throw a labeled error.
 */
async function requestApi<Result extends Readonly<EndpointFetchOutput>>(
    label: string,
    runFetch: () => Promise<Result>,
): Promise<NonNullable<Result['Ok']>['responseData']> {
    const result = await runFetch().catch((error: unknown) => {
        notifyBackendFailure();
        throw error;
    });
    if (result.Ok) {
        notifyBackendSuccess();
        return result.Ok.responseData;
    }
    notifyBackendSuccess();
    const errorOutput = result.unexpectedError;
    if (errorOutput?.status === HttpStatus.Unauthorized) {
        clearStoredSecret();
    }
    throw new Error(`${label} failed: ${String(errorOutput?.responseData)}`);
}

export async function getConfig(): Promise<Config> {
    return await requestApi('GET /config', () => client.fetch(configEndpoint).GET());
}

export async function putConfig(config: Readonly<Config>): Promise<Config> {
    return await requestApi('PUT /config', () => {
        return client.fetch(configEndpoint).PUT({
            requestData: config,
        });
    });
}

export async function getFolders(): Promise<FolderInfo[]> {
    const data = await requestApi('GET /folders', () => client.fetch(foldersEndpoint).GET());
    return data.folders;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
    return await requestApi('GET /update-check', () => client.fetch(updateCheckEndpoint).GET());
}

export async function createWorktree(
    params: Readonly<{
        repoPath: string;
        name: string;
        aiId?: string | undefined;
    }>,
): Promise<void> {
    await requestApi('POST /worktrees/create', () => {
        return client.fetch(createWorktreeEndpoint).POST({
            requestData: params,
        });
    });
}

export async function deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void> {
    await requestApi('POST /worktrees/delete', () => {
        return client.fetch(deleteWorktreeEndpoint).POST({
            requestData: params,
        });
    });
}

export async function touchRepo(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /repos/touch', () => {
        return client.fetch(touchRepoEndpoint).POST({
            requestData: params,
        });
    });
}

export async function hideRepo(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /repos/hide', () => {
        return client.fetch(hideRepoEndpoint).POST({
            requestData: params,
        });
    });
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind; sessionId?: string | undefined}>,
): Promise<void> {
    await requestApi('POST /panes/restart', () => {
        return client.fetch(restartPaneEndpoint).POST({
            requestData: params,
        });
    });
}

export async function getFolderSessions(
    params: Readonly<{folder: string}>,
): Promise<FolderSessions> {
    return await requestApi('POST /sessions/list', () => {
        return client.fetch(sessionListEndpoint).POST({
            requestData: params,
        });
    });
}

export async function createSession(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<FolderSessions> {
    return await requestApi('POST /sessions/create', () => {
        return client.fetch(sessionCreateEndpoint).POST({
            requestData: params,
        });
    });
}

export async function renameSession(
    params: Readonly<{folder: string; kind: PaneKind; sessionId: string; name: string}>,
): Promise<FolderSessions> {
    return await requestApi('POST /sessions/rename', () => {
        return client.fetch(sessionRenameEndpoint).POST({
            requestData: params,
        });
    });
}

export async function closeSession(
    params: Readonly<{folder: string; kind: PaneKind; sessionId: string}>,
): Promise<FolderSessions> {
    return await requestApi('POST /sessions/close', () => {
        return client.fetch(sessionCloseEndpoint).POST({
            requestData: params,
        });
    });
}

/** Empty `aiId` clears the tab's override so it follows its folder's AI again. */
export async function setSessionAi(
    params: Readonly<{folder: string; kind: PaneKind; sessionId: string; aiId: string}>,
): Promise<FolderSessions> {
    return await requestApi('POST /sessions/set-ai', () => {
        return client.fetch(sessionSetAiEndpoint).POST({
            requestData: params,
        });
    });
}

export async function uploadAiAvatar(
    params: Readonly<{filename: string; dataBase64: string}>,
): Promise<string> {
    const data = await requestApi('POST /ai/avatar/upload', () => {
        return client.fetch(aiAvatarUploadEndpoint).POST({
            requestData: params,
        });
    });
    return data.avatarFile;
}

export async function getAiAvatar(
    avatarFile: string,
): Promise<{dataBase64: string; mimeType: string}> {
    return await requestApi('POST /ai/avatar', () => {
        return client.fetch(aiAvatarEndpoint).POST({
            requestData: {
                avatarFile,
            },
        });
    });
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /panes/kill', () => {
        return client.fetch(killPanesEndpoint).POST({
            requestData: params,
        });
    });
}

export async function restartDaemon(): Promise<void> {
    await requestApi('POST /daemon/restart', () => client.fetch(restartDaemonEndpoint).POST());
}

export async function getGitDiffStatus(params: Readonly<{folder: string}>): Promise<GitDiffStatus> {
    return await requestApi('POST /git/diff/status', () => {
        return client.fetch(gitDiffStatusEndpoint).POST({
            requestData: params,
        });
    });
}

export async function getGitDiffFile(
    params: Readonly<{
        folder: string;
        path: string;
        oldPath?: string | undefined;
        side: GitDiffSide;
        allowLarge: boolean;
    }>,
): Promise<GitDiffFileContents> {
    return await requestApi('POST /git/diff/file', () => {
        return client.fetch(gitDiffFileEndpoint).POST({
            requestData: params,
        });
    });
}

/**
 * Move a whole file across the index. `side` is where the file currently sits, so passing
 * `Unstaged` stages it and passing `Staged` unstages it.
 */
export async function setGitFileStaged(
    params: Readonly<{folder: string; path: string; side: GitDiffSide}>,
): Promise<void> {
    await requestApi('POST /git/stage/file', () => {
        return client.fetch(gitStageFileEndpoint).POST({
            requestData: params,
        });
    });
}

/** Same as {@link setGitFileStaged} but for every file currently on `side`. */
export async function setGitSideStaged(
    params: Readonly<{folder: string; side: GitDiffSide}>,
): Promise<void> {
    await requestApi('POST /git/stage/all', () => {
        return client.fetch(gitStageAllEndpoint).POST({
            requestData: params,
        });
    });
}

/** Same as {@link setGitFileStaged} but for one chunk, addressed by its line ranges. */
export async function setGitHunkStaged(
    params: Readonly<{
        folder: string;
        path: string;
        oldPath?: string | undefined;
        side: GitDiffSide;
        fromOldLine: number;
        toOldLine: number;
        fromNewLine: number;
        toNewLine: number;
    }>,
): Promise<void> {
    await requestApi('POST /git/stage/hunk', () => {
        return client.fetch(gitStageHunkEndpoint).POST({
            requestData: params,
        });
    });
}

/**
 * Throw away one chunk's change, addressed exactly like {@link setGitHunkStaged}. Cannot be reversed
 * — confirm before calling.
 */
export async function discardGitHunk(
    params: Readonly<{
        folder: string;
        path: string;
        oldPath?: string | undefined;
        side: GitDiffSide;
        fromOldLine: number;
        toOldLine: number;
        fromNewLine: number;
        toNewLine: number;
    }>,
): Promise<void> {
    await requestApi('POST /git/discard/hunk', () => {
        return client.fetch(gitDiscardHunkEndpoint).POST({
            requestData: params,
        });
    });
}

/**
 * Throw away a file's changes on both sides of the index. Cannot be reversed — confirm before
 * calling.
 */
export async function discardGitFile(
    params: Readonly<{folder: string; path: string}>,
): Promise<void> {
    await requestApi('POST /git/discard/file', () => {
        return client.fetch(gitDiscardFileEndpoint).POST({
            requestData: params,
        });
    });
}

/**
 * Throw away every unstaged change in the repo, leaving staged changes in place. Cannot be reversed
 * — confirm before calling.
 */
export async function discardUnstagedGitChanges(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /git/discard/unstaged', () => {
        return client.fetch(gitDiscardUnstagedEndpoint).POST({
            requestData: params,
        });
    });
}

/** Null when the folder's branch has no PR, or GitHub isn't reachable through `gh`. */
export async function getGitHubPr(
    params: Readonly<{folder: string; forceRefresh: boolean}>,
): Promise<GitHubPr | null> {
    const data = await requestApi('POST /github/pr', () => {
        return client.fetch(gitHubPrEndpoint).POST({
            requestData: params,
        });
    });
    return data.pr ?? null;
}

export async function postGitHubComment(
    params: Readonly<{target: GitHubCommentTarget; subjectId: string; body: string}>,
): Promise<void> {
    await requestApi('POST /github/comment', () => {
        return client.fetch(gitHubCommentEndpoint).POST({
            requestData: params,
        });
    });
}

export async function setGitHubReaction(
    params: Readonly<{subjectId: string; reaction: GitHubReaction; add: boolean}>,
): Promise<void> {
    await requestApi('POST /github/reaction', () => {
        return client.fetch(gitHubReactionEndpoint).POST({
            requestData: params,
        });
    });
}

export async function setGitHubThreadResolved(
    params: Readonly<{threadId: string; resolved: boolean}>,
): Promise<void> {
    await requestApi('POST /github/thread/resolve', () => {
        return client.fetch(gitHubResolveThreadEndpoint).POST({
            requestData: params,
        });
    });
}

export async function uploadFile(
    params: Readonly<{filename: string; dataBase64: string}>,
): Promise<string> {
    const data = await requestApi('POST /uploads/create', () => {
        return client.fetch(uploadEndpoint).POST({
            requestData: params,
        });
    });
    return data.path;
}

export async function checkPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string; exists: boolean}> {
    return await requestApi('POST /paths/check', () => {
        return client.fetch(checkPathEndpoint).POST({
            requestData: params,
        });
    });
}

export async function createPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string}> {
    return await requestApi('POST /paths/create', () => {
        return client.fetch(createPathEndpoint).POST({
            requestData: params,
        });
    });
}

/**
 * Append one browser-side error to the backend's client-error log. Sent through `requestApi` like
 * everything else, which means a report made before the auth secret is entered waits for it rather
 * than being dropped.
 */
export async function reportClientError(
    params: Readonly<{
        message: string;
        stack?: string | undefined;
        source: string;
        pageUrl: string;
    }>,
): Promise<void> {
    await requestApi('POST /client-error', () => {
        return client.fetch(clientErrorEndpoint).POST({
            requestData: params,
        });
    });
}
