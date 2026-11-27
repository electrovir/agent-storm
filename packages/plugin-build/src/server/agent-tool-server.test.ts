import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type AgentToolConnection, startAgentToolServer} from './agent-tool-server.js';
import {type AgentToolContext} from './agent-tools.js';

const archivedThreadId = 'archived-thread';

async function startTestServer(dataDir: string) {
    return await startAgentToolServer({
        tools: [],
        context: {
            isThreadActive(threadId) {
                return Promise.resolve(threadId !== archivedThreadId);
            },
        } satisfies Partial<AgentToolContext> as AgentToolContext,
        instructions: '',
        dataDir,
    });
}

/** Lists the tools as `connection`, returning the response's HTTP status. */
async function requestStatus({url, token}: AgentToolConnection) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
        }),
    });
    await response.body?.cancel();
    return response.status;
}

async function withDataDir(callback: (dataDir: string) => Promise<void>) {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-tool-server-test-'));
    try {
        await callback(dataDir);
    } finally {
        await rm(dataDir, {
            recursive: true,
            force: true,
        });
    }
}

describe(startAgentToolServer.name, () => {
    it('accepts only tokens it signed', async () => {
        await withDataDir(async (dataDir) => {
            const server = await startTestServer(dataDir);
            try {
                const connection = server.connect('thread-1');
                const signature = connection.token.slice(connection.token.lastIndexOf('.') + 1);
                const tamperedSignature = `${signature.startsWith('0') ? '1' : '0'}${signature.slice(1)}`;
                assert.deepEquals(
                    {
                        valid: await requestStatus(connection),
                        otherThread: await requestStatus({
                            ...connection,
                            token: `thread-2.${signature}`,
                        }),
                        tampered: await requestStatus({
                            ...connection,
                            token: `thread-1.${tamperedSignature}`,
                        }),
                        truncated: await requestStatus({
                            ...connection,
                            token: connection.token.slice(0, -1),
                        }),
                        noSeparator: await requestStatus({
                            ...connection,
                            token: signature,
                        }),
                        archived: await requestStatus(server.connect(archivedThreadId)),
                    },
                    {
                        valid: 200,
                        otherThread: 401,
                        tampered: 401,
                        truncated: 401,
                        noSeparator: 401,
                        archived: 401,
                    },
                );
            } finally {
                await server.stop();
            }
        });
    });

    it("keeps the last run's port and tokens", async () => {
        await withDataDir(async (dataDir) => {
            const firstServer = await startTestServer(dataDir);
            const firstConnection = firstServer.connect('thread-1');
            await firstServer.stop();
            const secondServer = await startTestServer(dataDir);
            try {
                assert.deepEquals(
                    {
                        connection: secondServer.connect('thread-1'),
                        status: await requestStatus(firstConnection),
                    },
                    {
                        connection: firstConnection,
                        status: 200,
                    },
                );
            } finally {
                await secondServer.stop();
            }
        });
    });
});
