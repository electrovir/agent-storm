import {agentStormService, type Config, type FolderInfo, type PaneKind} from '@agent-storm/common';
import {HttpMethod} from '@augment-vir/common';
import {fetchEndpoint} from '@rest-vir/define-service';

async function ensureOk<Data>(
    result: {ok: true; data: Data} | {ok: false; data: unknown},
    label: string,
): Promise<Data> {
    if (!result.ok) {
        throw new Error(`${label} failed: ${String(result.data)}`);
    }
    return result.data;
}

export async function getConfig(): Promise<Config> {
    return await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/config'], {
            method: HttpMethod.Get,
            requestData: undefined,
        }),
        'GET /config',
    );
}

export async function putConfig(config: Readonly<Config>): Promise<Config> {
    return await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/config'], {
            method: HttpMethod.Put,
            requestData: config,
        }),
        'PUT /config',
    );
}

export async function getFolders(): Promise<FolderInfo[]> {
    const data = await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/folders']),
        'GET /folders',
    );
    return data.folders;
}

export async function createWorktree(
    params: Readonly<{repoPath: string; name: string}>,
): Promise<void> {
    await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/worktrees/create'], {
            requestData: params,
        }),
        'POST /worktrees/create',
    );
}

export async function deleteWorktree(params: Readonly<{worktreePath: string}>): Promise<void> {
    await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/worktrees/delete'], {
            requestData: params,
        }),
        'POST /worktrees/delete',
    );
}

export async function restartPane(
    params: Readonly<{folder: string; kind: PaneKind}>,
): Promise<void> {
    await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/panes/restart'], {
            requestData: params,
        }),
        'POST /panes/restart',
    );
}

export async function killFolderPanes(params: Readonly<{folder: string}>): Promise<void> {
    await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/panes/kill'], {
            requestData: params,
        }),
        'POST /panes/kill',
    );
}

export async function restartDaemon(): Promise<void> {
    await ensureOk(
        await fetchEndpoint(agentStormService.endpoints['/daemon/restart']),
        'POST /daemon/restart',
    );
}
