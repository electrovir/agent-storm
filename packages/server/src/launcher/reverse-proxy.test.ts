import {assert} from '@augment-vir/assert';
import {HttpStatus} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {once} from 'node:events';
import {createServer, request, type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import {type Duplex} from 'node:stream';
import {proxyRequest, proxyUpgrade} from './reverse-proxy.js';

async function listenOnFreePort(server: Server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() satisfies string | AddressInfo | null as AddressInfo).port;
}

/** Replies with what it received, and echoes everything sent over an upgraded connection. */
function createEchoServer() {
    const server = createServer(async (incoming, response) => {
        const body = Buffer.concat(await incoming.toArray()).toString();
        response.end(`${incoming.method} ${incoming.url} ${body}`);
    });
    server.on('upgrade', (incoming, socket: Duplex) => {
        socket.write(
            [
                'HTTP/1.1 101 Switching Protocols',
                `Upgrade: ${incoming.headers.upgrade}`,
                'Connection: Upgrade',
                '',
                '',
            ].join('\r\n'),
        );
        socket.pipe(socket);
    });
    return server;
}

function createProxyServer(targetPort: number) {
    const server = createServer((incoming, response) => {
        proxyRequest({
            incoming,
            response,
            targetPort,
        });
    });
    server.on('upgrade', (incoming, socket: Duplex, head: Buffer) => {
        proxyUpgrade({
            incoming,
            socket,
            head,
            targetPort,
        });
    });
    return server;
}

async function withServers(
    callback: (proxyPort: number) => Promise<void>,
    {
        isTargetDown,
    }: Readonly<{
        isTargetDown?: boolean | undefined;
    }> = {},
) {
    const target = createEchoServer();
    const targetPort = await listenOnFreePort(target);
    if (isTargetDown) {
        target.close();
        await once(target, 'close');
    }
    const proxy = createProxyServer(targetPort);
    const proxyPort = await listenOnFreePort(proxy);
    try {
        await callback(proxyPort);
    } finally {
        [
            proxy,
            target,
        ].forEach((server) => {
            server.closeAllConnections();
            server.close();
        });
    }
}

describe(proxyRequest.name, () => {
    it('forwards the method, path, and body', async () => {
        await withServers(async (proxyPort) => {
            const response = await fetch(`http://127.0.0.1:${proxyPort}/some/path?query=1`, {
                method: 'POST',
                body: 'hello',
            });

            assert.strictEquals(await response.text(), 'POST /some/path?query=1 hello');
        });
    });
    it('answers 502 when the target is down', async () => {
        await withServers(
            async (proxyPort) => {
                const response = await fetch(`http://127.0.0.1:${proxyPort}/`);

                assert.strictEquals(response.status, HttpStatus.BadGateway);
            },
            {
                isTargetDown: true,
            },
        );
    });
    it('answers 503 without a target', async () => {
        const proxy = createServer((incoming, response) => {
            proxyRequest({
                incoming,
                response,
                targetPort: undefined,
            });
        });
        const proxyPort = await listenOnFreePort(proxy);
        try {
            const response = await fetch(`http://127.0.0.1:${proxyPort}/`);

            assert.strictEquals(response.status, HttpStatus.ServiceUnavailable);
        } finally {
            proxy.closeAllConnections();
            proxy.close();
        }
    });
});

describe(proxyUpgrade.name, () => {
    it('pipes an upgraded connection both ways', async () => {
        await withServers(async (proxyPort) => {
            const upgradeRequest = request({
                host: '127.0.0.1',
                port: proxyPort,
                headers: {
                    connection: 'Upgrade',
                    upgrade: 'echo',
                },
            });
            upgradeRequest.end();
            const [
                ,
                socket,
            ] = (await once(upgradeRequest, 'upgrade')) satisfies unknown[] as [
                unknown,
                Duplex,
            ];
            socket.write('ping');
            const [data] = (await once(socket, 'data')) satisfies unknown[] as [Buffer];
            socket.destroy();

            assert.strictEquals(data.toString(), 'ping');
        });
    });
});
