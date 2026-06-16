import {
    agentStormService,
    checkPathEndpoint,
    configEndpoint,
    createPathEndpoint,
    createWorktreeEndpoint,
    deleteWorktreeEndpoint,
    foldersEndpoint,
    killPanesEndpoint,
    resetAiSessionEndpoint,
    restartDaemonEndpoint,
    restartPaneEndpoint,
    touchRepoEndpoint,
    updateCheckEndpoint,
    uploadEndpoint,
    type Config,
    type FolderInfo,
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
    return await requestApi('PUT /config', () =>
        client.fetch(configEndpoint).PUT({
            requestData: config,
        }),
    );
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
        aiCmd?: string | undefined;
        resetAiSessionCmd?: string | undefined;
    }>,
): Promise<void> {
    await requestApi('POST /worktrees/create', () =>
        client.fetch(createWorktreeEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void> {
    await requestApi('POST /worktrees/delete', () =>
        client.fetch(deleteWorktreeEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function touchRepo(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /repos/touch', () =>
        client.fetch(touchRepoEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<void> {
    await requestApi('POST /panes/restart', () =>
        client.fetch(restartPaneEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /panes/kill', () =>
        client.fetch(killPanesEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function resetAiSession(params: Readonly<{folder: string}>): Promise<void> {
    await requestApi('POST /panes/reset-ai-session', () =>
        client.fetch(resetAiSessionEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function restartDaemon(): Promise<void> {
    await requestApi('POST /daemon/restart', () => client.fetch(restartDaemonEndpoint).POST());
}

/**
 * Spawn (or reuse) a VS Code instance for the given folder and prime the proxy's session cookie.
 * Returns the path prefix the iframe should use (e.g. `/vscode-proxy/<encoded folder>`); the
 * frontend builds the full iframe `src` by concatenating with the backend origin.
 *
 * Bypasses the rest-vir client because the proxy endpoints aren't part of the api definition — they
 * need raw cookie + WebSocket handling that rest-vir doesn't expose. Uses the same bearer header
 * and credentials policy so the cookie is accepted by the browser.
 */
export async function ensureVscode(params: Readonly<{folder: string}>): Promise<{
    basePath: string;
}> {
    const bearer = await ensureSecret();
    const response = await fetch(`${getBackendBaseUrl()}/vscode/ensure`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(params),
    });
    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`POST /vscode/ensure failed: ${response.status} ${message}`);
    }
    return (await response.json()) as {basePath: string};
}

export async function killVscode(params: Readonly<{folder: string}>): Promise<void> {
    const bearer = await ensureSecret();
    const response = await fetch(`${getBackendBaseUrl()}/vscode/kill`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(params),
    });
    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`POST /vscode/kill failed: ${response.status} ${message}`);
    }
}

export async function uploadFile(
    params: Readonly<{filename: string; dataBase64: string}>,
): Promise<string> {
    const data = await requestApi('POST /uploads/create', () =>
        client.fetch(uploadEndpoint).POST({
            requestData: params,
        }),
    );
    return data.path;
}

export async function checkPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string; exists: boolean}> {
    return await requestApi('POST /paths/check', () =>
        client.fetch(checkPathEndpoint).POST({
            requestData: params,
        }),
    );
}

export async function createPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string}> {
    return await requestApi('POST /paths/create', () =>
        client.fetch(createPathEndpoint).POST({
            requestData: params,
        }),
    );
}
