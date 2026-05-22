import {agentStormService, type Config, type FolderInfo, type PaneKind} from '@agent-storm/common';
import {HttpMethod} from '@augment-vir/common';
import {fetchEndpoint} from '@rest-vir/define-service';
import {clearStoredSecret, ensureSecret} from './auth.js';

async function authOptions(): Promise<{options: {headers: Record<string, string>}}> {
    return {
        options: {
            headers: {
                Authorization: `Bearer ${await ensureSecret()}`,
            },
        },
    };
}

function ensureOk<Data>(
    result:
        | {ok: true; data: Data}
        | {ok: false; data: unknown; response?: {status?: number} | undefined},
    label: string,
): Data {
    if (!result.ok) {
        if (result.response?.status === 401) {
            clearStoredSecret();
        }
        throw new Error(`${label} failed: ${String(result.data)}`);
    }
    return result.data;
}

export async function getConfig(): Promise<Config> {
    const options = await authOptions();
    return ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/config'], {
            ...options,
            method: HttpMethod.Get,
            requestData: undefined,
        }),
        'GET /config',
    );
}

export async function putConfig(config: Readonly<Config>): Promise<Config> {
    const options = await authOptions();
    return ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/config'], {
            ...options,
            method: HttpMethod.Put,
            requestData: config,
        }),
        'PUT /config',
    );
}

export async function getFolders(): Promise<FolderInfo[]> {
    const options = await authOptions();
    const data = ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/folders'], options),
        'GET /folders',
    );
    return data.folders;
}

export async function createWorktree(
    params: Readonly<{repoPath: string; name: string}>,
): Promise<void> {
    const options = await authOptions();
    ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/worktrees/create'], {
            ...options,
            requestData: params,
        }),
        'POST /worktrees/create',
    );
}

export async function deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void> {
    const options = await authOptions();
    ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/worktrees/delete'], {
            ...options,
            requestData: params,
        }),
        'POST /worktrees/delete',
    );
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<void> {
    const options = await authOptions();
    ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/panes/restart'], {
            ...options,
            requestData: params,
        }),
        'POST /panes/restart',
    );
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    const options = await authOptions();
    ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/panes/kill'], {
            ...options,
            requestData: params,
        }),
        'POST /panes/kill',
    );
}

export async function restartDaemon(): Promise<void> {
    const options = await authOptions();
    ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/daemon/restart'], options),
        'POST /daemon/restart',
    );
}

export async function uploadFile(
    params: Readonly<{filename: string; dataBase64: string}>,
): Promise<string> {
    const options = await authOptions();
    const data = ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/uploads/create'], {
            ...options,
            requestData: params,
        }),
        'POST /uploads/create',
    );
    return data.path;
}
