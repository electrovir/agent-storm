import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {McpServerState, type McpServer} from '../build-v2-api.js';
import {applyMcpChange} from './mcp-control.js';
import {type McpControl} from './providers/provider-session.js';

function createServer(state: McpServerState): McpServer {
    return {
        name: 'docs',
        state,
        error: '',
        scope: 'user',
        toolCount: 0,
    };
}

/** A control whose list reads each of `states` in turn, then keeps reading the last one. */
function createControl(states: ReadonlyArray<McpServerState>) {
    const reads = {
        count: 0,
    };
    const control: McpControl = {
        listServers() {
            const state = states[Math.min(reads.count, states.length - 1)] || McpServerState.Failed;
            reads.count++;
            return Promise.resolve([
                createServer(state),
            ]);
        },
        setServerEnabled() {
            return Promise.reject(new Error('Connection timed out.'));
        },
        reconnectServer() {
            return Promise.resolve();
        },
        signIn() {
            return Promise.resolve({
                authUrl: '',
                isCallbackExpected: false,
            });
        },
        submitSignInCallbackUrl() {
            return Promise.resolve();
        },
    };
    return {
        control,
        reads,
    };
}

describe(applyMcpChange.name, () => {
    it('waits for a new session to connect its servers', async () => {
        const {control, reads} = createControl([
            McpServerState.Pending,
            McpServerState.Connected,
        ]);

        assert.deepEquals(
            await applyMcpChange({
                control,
                change: undefined,
                isConnectAwaited: true,
            }),
            {
                servers: [
                    createServer(McpServerState.Connected),
                ],
                error: '',
            },
        );
        assert.strictEquals(reads.count, 2);
    });

    it('reports a failed change and still lists the servers', async () => {
        const {control} = createControl([
            McpServerState.Pending,
        ]);

        assert.deepEquals(
            await applyMcpChange({
                control,
                async change(changed) {
                    await changed.setServerEnabled({
                        serverName: 'docs',
                        isEnabled: true,
                    });
                },
                isConnectAwaited: false,
            }),
            {
                servers: [
                    createServer(McpServerState.Pending),
                ],
                error: 'Connection timed out.',
            },
        );
    });
});
