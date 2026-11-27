import {assert} from '@augment-vir/assert';
import {PromiseTimeoutError} from '@augment-vir/common';
import {assertWrapTestContext, describe, it, TestEnv} from '@augment-vir/test';
import {convertDuration} from 'date-vir';
import {setImmediate} from 'node:timers/promises';
import {McpServerState, type McpServer} from '../build-api.js';
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

    it('returns the last status when the deadline passes between polls', async (context) => {
        const {mock} = assertWrapTestContext(context, TestEnv.Node);
        mock.timers.enable({
            apis: [
                'Date',
                'setTimeout',
            ],
        });
        const {control, reads} = createControl([
            McpServerState.Pending,
            McpServerState.Connected,
        ]);
        const result = applyMcpChange({
            control,
            change: undefined,
            isConnectAwaited: true,
        });
        await setImmediate();
        mock.timers.tick(
            convertDuration(
                {
                    seconds: 15,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );

        assert.deepEquals(await result, {
            servers: [
                createServer(McpServerState.Pending),
            ],
            error: '',
        });
        assert.strictEquals(reads.count, 1);
    });

    it('returns the last status when a follow-up read stalls past the deadline', async (context) => {
        const {mock} = assertWrapTestContext(context, TestEnv.Node);
        mock.timers.enable({
            apis: [
                'Date',
                'setTimeout',
            ],
        });
        const {control, reads} = createControl([
            McpServerState.Pending,
        ]);
        const listServers = mock.fn(() => {
            return reads.count
                ? Promise.withResolvers<McpServer[]>().promise
                : control.listServers();
        });
        const result = applyMcpChange({
            control: {
                ...control,
                listServers,
            },
            change: undefined,
            isConnectAwaited: true,
        });
        await setImmediate();
        mock.timers.tick(
            convertDuration(
                {
                    milliseconds: 500,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );
        await setImmediate();
        assert.strictEquals(listServers.mock.callCount(), 2);
        mock.timers.tick(
            convertDuration(
                {
                    seconds: 15,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );

        assert.deepEquals(
            await Promise.race([
                result,
                setImmediate(),
            ]),
            {
                servers: [
                    createServer(McpServerState.Pending),
                ],
                error: '',
            },
        );
    });

    it('reports a timeout when a running session stalls while listing its servers', async (context) => {
        const {mock} = assertWrapTestContext(context, TestEnv.Node);
        mock.timers.enable({
            apis: [
                'Date',
                'setTimeout',
            ],
        });
        const {control} = createControl([]);
        const result = applyMcpChange({
            control: {
                ...control,
                listServers() {
                    return Promise.withResolvers<McpServer[]>().promise;
                },
            },
            change: undefined,
            isConnectAwaited: false,
        }).catch((error: unknown) => error);
        await setImmediate();
        mock.timers.tick(
            convertDuration(
                {
                    seconds: 15,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );

        assert.isError(
            await Promise.race([
                result,
                setImmediate(),
            ]),
            {
                matchConstructor: PromiseTimeoutError,
                matchMessage: 'Reading MCP server status',
            },
        );
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
