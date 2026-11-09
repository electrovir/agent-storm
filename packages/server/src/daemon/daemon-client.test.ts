import {assert} from '@augment-vir/assert';
import {wrapPromiseInTimeout} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {createConnection, createServer, type Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requestDaemonReply} from './daemon-client.js';
import {DaemonAction, encodeControlFrame, type StatusResponse} from './protocol.js';

/**
 * Runs `test` against a client socket connected to a fake daemon that handles each connection with
 * `onConnection`.
 */
async function withFakeDaemon(
    onConnection: (socket: Socket) => void,
    test: (client: Socket) => Promise<void>,
) {
    const dir = await mkdtemp(join(tmpdir(), 'agent-storm-daemon-client-'));
    const unixSocketPath = join(dir, 'daemon.sock');
    const socketPath = (
        {
            [OperatingSystem.Mac]: unixSocketPath,
            [OperatingSystem.Linux]: unixSocketPath,
            [OperatingSystem.Windows]: String.raw`\\.\pipe\${basename(dir)}`,
        } satisfies Record<OperatingSystem, string>
    )[currentOperatingSystem];
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
        sockets.push(socket);
        onConnection(socket);
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
        const client = await new Promise<Socket>((resolve, reject) => {
            const socket = createConnection(socketPath);
            socket.once('connect', () => resolve(socket));
            socket.once('error', reject);
        });
        sockets.push(client);
        await test(client);
    } finally {
        sockets.forEach((socket) => socket.destroy());
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(dir, {
            recursive: true,
            force: true,
        });
    }
}

describe(requestDaemonReply.name, () => {
    it('resolves with the first control frame', async () => {
        const reply: StatusResponse = {
            ok: true,
            panes: [],
            protocolVersion: 4,
        };
        await withFakeDaemon(
            (socket) => {
                socket.once('data', () => {
                    socket.end(encodeControlFrame(reply));
                });
            },
            async (client) => {
                assert.deepEquals(
                    await requestDaemonReply({
                        socket: client,
                        handshake: {
                            action: DaemonAction.Status,
                        },
                        timeout: {
                            seconds: 5,
                        },
                    }),
                    reply,
                );
            },
        );
    });

    it('rejects when the daemon never answers', async () => {
        await withFakeDaemon(
            () => {},
            async (client) => {
                /** The outer bound only fails the test, with a message the assertion won't match. */
                await assert.throws(
                    wrapPromiseInTimeout(
                        {
                            seconds: 2,
                        },
                        requestDaemonReply({
                            socket: client,
                            handshake: {
                                action: DaemonAction.Status,
                            },
                            timeout: {
                                milliseconds: 100,
                            },
                        }),
                    ),
                    {
                        matchMessage: 'did not answer status',
                    },
                );
                assert.isTrue(client.destroyed);
            },
        );
    });

    it('rejects when the daemon closes the socket without answering', async () => {
        await withFakeDaemon(
            (socket) => {
                socket.once('data', () => {
                    socket.end();
                });
            },
            async (client) => {
                await assert.throws(
                    requestDaemonReply({
                        socket: client,
                        handshake: {
                            action: DaemonAction.Status,
                        },
                        timeout: {
                            seconds: 5,
                        },
                    }),
                    {
                        matchMessage: 'closed the socket before answering',
                    },
                );
            },
        );
    });
});
