import {agentStormService, type Config, type FolderInfo, type PaneKind} from '@agent-storm/common';
import {HttpMethod} from '@augment-vir/common';
import {fetchEndpoint} from '@rest-vir/define-service';
import {clearStoredSecret, ensureSecret} from './auth.js';
import {notifyBackendFailure, notifyBackendSuccess} from './backend-watchdog.js';

async function authOptions(): Promise<{options: {headers: Record<string, string>}}> {
    return {
        options: {
            headers: {
                Authorization: `Bearer ${await ensureSecret()}`,
            },
        },
    };
}

async function callApi<Data>(
    label: string,
    request: Promise<
        | {ok: true; data: Data}
        | {ok: false; data: unknown; response?: {status?: number} | undefined}
    >,
): Promise<Data> {
    /**
     * `fetchEndpoint` re-throws when the underlying `fetch` itself rejects (DNS / connect refused /
     * aborted — i.e. the backend process is gone). The result branch below only covers HTTP-level
     * failures where the server actually answered. Catch the throw here so the watchdog can count
     * it toward the recovery threshold; without this, a dead backend just produces silent polling
     * rejections and the page never reloads when the server comes back.
     */
    const result = await request.catch((error: unknown) => {
        notifyBackendFailure();
        throw error;
    });
    if (!result.ok) {
        if (result.response?.status === 401) {
            clearStoredSecret();
        }
        /**
         * Distinguish a transport failure (no `response.status` — fetch itself threw, backend is
         * unreachable) from an application-level error (any HTTP status, including 401/500). Only
         * the former should bump the watchdog toward a recovery reload; everything else means the
         * backend is alive and replying, even if the reply is an error.
         */
        if (result.response?.status == undefined) {
            notifyBackendFailure();
        } else {
            notifyBackendSuccess();
        }
        throw new Error(`${label} failed: ${String(result.data)}`);
    }
    notifyBackendSuccess();
    return result.data;
}

export async function getConfig(): Promise<Config> {
    const options = await authOptions();
    return await callApi(
        'GET /config',
        fetchEndpoint(agentStormService.endpoints['/config'], {
            ...options,
            method: HttpMethod.Get,
            requestData: undefined,
        }),
    );
}

export async function putConfig(config: Readonly<Config>): Promise<Config> {
    const options = await authOptions();
    return await callApi(
        'PUT /config',
        fetchEndpoint(agentStormService.endpoints['/config'], {
            ...options,
            method: HttpMethod.Put,
            requestData: config,
        }),
    );
}

export async function getFolders(): Promise<FolderInfo[]> {
    const options = await authOptions();
    const data = await callApi(
        'GET /folders',
        fetchEndpoint(agentStormService.endpoints['/folders'], options),
    );
    return data.folders;
}

export async function createWorktree(
    params: Readonly<{repoPath: string; name: string}>,
): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /worktrees/create',
        fetchEndpoint(agentStormService.endpoints['/worktrees/create'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /worktrees/delete',
        fetchEndpoint(agentStormService.endpoints['/worktrees/delete'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /panes/restart',
        fetchEndpoint(agentStormService.endpoints['/panes/restart'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function exitAiPaneToShell(params: Readonly<{folder: string}>): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /panes/exit-ai',
        fetchEndpoint(agentStormService.endpoints['/panes/exit-ai'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /panes/kill',
        fetchEndpoint(agentStormService.endpoints['/panes/kill'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function restartDaemon(): Promise<void> {
    const options = await authOptions();
    await callApi(
        'POST /daemon/restart',
        fetchEndpoint(agentStormService.endpoints['/daemon/restart'], options),
    );
}

/**
 * Spawn (or reuse) a VS Code instance for the given folder and prime the proxy's session cookie.
 * Returns the path prefix the iframe should use (e.g. `/vscode-proxy/<encoded folder>`); the
 * frontend builds the full iframe `src` by concatenating with the backend origin.
 *
 * Bypasses `fetchEndpoint` / `agentStormService` because the proxy endpoints aren't part of the
 * rest-vir service definition — they need raw cookie + WebSocket handling that rest-vir doesn't
 * expose. Uses the same bearer header and credentials policy so the cookie is accepted by the
 * browser.
 */
export async function ensureVscode(params: Readonly<{folder: string}>): Promise<{
    basePath: string;
}> {
    const bearer = await ensureSecret();
    const response = await fetch(`${agentStormService.serviceOrigin}/vscode/ensure`, {
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
    const response = await fetch(`${agentStormService.serviceOrigin}/vscode/kill`, {
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
    const options = await authOptions();
    const data = await callApi(
        'POST /uploads/create',
        fetchEndpoint(agentStormService.endpoints['/uploads/create'], {
            ...options,
            requestData: params,
        }),
    );
    return data.path;
}

export async function checkPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string; exists: boolean}> {
    const options = await authOptions();
    return await callApi(
        'POST /paths/check',
        fetchEndpoint(agentStormService.endpoints['/paths/check'], {
            ...options,
            requestData: params,
        }),
    );
}

export async function createPath(
    params: Readonly<{path: string}>,
): Promise<{resolvedPath: string}> {
    const options = await authOptions();
    return await callApi(
        'POST /paths/create',
        fetchEndpoint(agentStormService.endpoints['/paths/create'], {
            ...options,
            requestData: params,
        }),
    );
}
