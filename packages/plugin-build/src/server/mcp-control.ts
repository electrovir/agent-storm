import {
    extractErrorMessage,
    PromiseTimeoutError,
    wait,
    wrapPromiseInTimeout,
} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {McpServerState, type McpServer} from '../build-api.js';
import {type McpControl} from './providers/provider-session.js';

/**
 * Polls while `isConnectAwaited` is set and a server is connecting. `deadline` is in epoch
 * milliseconds. Recursive, so the return type can't be inferred.
 */
async function readMcpServerStatuses({
    control,
    deadline,
    isConnectAwaited,
}: Readonly<{
    control: McpControl;
    deadline: number;
    isConnectAwaited: boolean;
}>): Promise<McpServer[]> {
    const servers = await wrapPromiseInTimeout(
        {
            milliseconds: Math.max(0, deadline - Date.now()),
        },
        control.listServers(),
        'Reading MCP server status',
    );
    if (
        !isConnectAwaited ||
        Date.now() >= deadline ||
        !servers.some((server) => server.state === McpServerState.Pending)
    ) {
        return servers;
    }
    await wait({
        milliseconds: 500,
    });
    if (Date.now() >= deadline) {
        return servers;
    }
    try {
        return await readMcpServerStatuses({
            control,
            deadline,
            isConnectAwaited,
        });
    } catch (error) {
        if (error instanceof PromiseTimeoutError && Date.now() >= deadline) {
            return servers;
        }
        throw error;
    }
}

/**
 * Runs `change`, then lists the servers. A failed change is reported in `error` rather than thrown,
 * since the list shows what it left behind. A session that just started is still connecting its
 * servers, which `isConnectAwaited` waits out so they don't all read as pending.
 */
export async function applyMcpChange({
    control,
    change,
    isConnectAwaited,
}: Readonly<{
    control: McpControl;
    change: ((control: McpControl) => Promise<void>) | undefined;
    isConnectAwaited: boolean;
}>) {
    const error = change
        ? await change(control).then(
              () => '',
              (caught: unknown) => extractErrorMessage(caught),
          )
        : '';
    return {
        servers: await readMcpServerStatuses({
            control,
            isConnectAwaited,
            deadline:
                Date.now() +
                convertDuration(
                    {
                        seconds: 15,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
        }),
        error,
    };
}
