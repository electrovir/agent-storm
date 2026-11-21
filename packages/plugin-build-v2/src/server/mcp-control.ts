import {extractErrorMessage, wait} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {McpServerState, type McpServer} from '../build-v2-api.js';
import {type McpControl} from './providers/provider-session.js';

/**
 * Lists `control`'s servers again until none is still connecting or `deadline` (epoch milliseconds)
 * passes. Recursive, so the return type can't be inferred.
 */
async function waitForMcpConnections({
    control,
    deadline,
}: Readonly<{
    control: McpControl;
    deadline: number;
}>): Promise<McpServer[]> {
    const servers = await control.listServers();
    if (
        Date.now() >= deadline ||
        !servers.some((server) => server.state === McpServerState.Pending)
    ) {
        return servers;
    }
    await wait({
        milliseconds: 500,
    });
    return await waitForMcpConnections({
        control,
        deadline,
    });
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
        servers: isConnectAwaited
            ? await waitForMcpConnections({
                  control,
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
              })
            : await control.listServers(),
        error,
    };
}
