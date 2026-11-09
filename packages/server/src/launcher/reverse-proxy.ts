import {chunkArray, HttpStatus} from '@augment-vir/common';
import {type IncomingMessage, request, type ServerResponse} from 'node:http';
import {connect} from 'node:net';
import {type Duplex} from 'node:stream';

const targetHost = '127.0.0.1';

/**
 * Forwards one HTTP request to the server on `targetPort`, streaming both bodies. Without a target,
 * answers 503 so the browser retries.
 */
export function proxyRequest({
    incoming,
    response,
    targetPort,
}: Readonly<{
    incoming: IncomingMessage;
    response: ServerResponse;
    targetPort: number | undefined;
}>) {
    if (targetPort == undefined) {
        response.writeHead(HttpStatus.ServiceUnavailable).end();
        return;
    }
    const outgoing = request(
        {
            host: targetHost,
            port: targetPort,
            method: incoming.method,
            path: incoming.url,
            headers: incoming.headers,
        },
        (targetResponse) => {
            response.writeHead(
                targetResponse.statusCode ?? HttpStatus.BadGateway,
                targetResponse.statusMessage,
                targetResponse.headers,
            );
            targetResponse.pipe(response);
        },
    );
    outgoing.on('error', () => {
        if (response.headersSent || response.destroyed) {
            response.destroy();
        } else {
            response.writeHead(HttpStatus.BadGateway).end();
        }
    });
    /** A browser that gives up on a long response (an event stream) must not leave it running. */
    response.on('close', () => {
        outgoing.destroy();
    });
    incoming.pipe(outgoing);
}

/**
 * Forwards a WebSocket upgrade to the server on `targetPort` by replaying the request on a raw
 * connection, then piping both directions, so frames pass through untouched.
 */
export function proxyUpgrade({
    incoming,
    socket,
    head,
    targetPort,
}: Readonly<{
    incoming: IncomingMessage;
    socket: Duplex;
    /** The first bytes after the request headers, which Node hands over with the `upgrade` event. */
    head: Buffer;
    targetPort: number | undefined;
}>) {
    if (targetPort == undefined) {
        socket.end(`HTTP/1.1 ${HttpStatus.ServiceUnavailable} Service Unavailable\r\n\r\n`);
        return;
    }
    const upstream = connect(targetPort, targetHost, () => {
        upstream.write(
            [
                `${incoming.method || 'GET'} ${incoming.url || '/'} HTTP/${incoming.httpVersion}`,
                ...chunkArray(incoming.rawHeaders, {
                    chunkSize: 2,
                }).map((nameAndValue) => nameAndValue.join(': ')),
                '',
                '',
            ].join('\r\n'),
        );
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
    });
    upstream.on('error', () => {
        socket.destroy();
    });
    socket.on('error', () => {
        upstream.destroy();
    });
    upstream.on('close', () => {
        socket.destroy();
    });
    socket.on('close', () => {
        upstream.destroy();
    });
}
