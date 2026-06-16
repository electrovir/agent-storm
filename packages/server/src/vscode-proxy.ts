// cspell:words exfiltrating, titlebar, torm

import {log} from '@augment-vir/common';
import {type FastifyInstance, type FastifyReply, type FastifyRequest} from 'fastify';
import {request as httpRequest, type IncomingMessage} from 'node:http';
import {connect as netConnect, type Socket} from 'node:net';
import {verifyAuthToken} from './auth.js';
import {ensureVscode, killVscode, listVscode} from './daemon/daemon-client.js';

/**
 * Cookie name carrying the agent-storm bearer for the iframe-served VS Code panes. Scoped to the
 * proxy path so it's never sent to other endpoints. Value is the cleartext bearer; verified against
 * the same argon2 hash that gates the rest of the backend (`verifyAuthToken`).
 */
const vscodeBearerCookieName = 'agent-storm-vscode-bearer';

/**
 * Root prefix of the proxy. A single base64url-encoded folder id segment goes immediately after —
 * e.g. `/vscode-proxy/L1VzZXJzL2VsZWN0cm92aXIvcmVwb3MvbXktcmVwbw/`. We pass this prefix to `code
 * serve-web --server-base-path` so asset URLs in the served HTML resolve to the proxy.
 *
 * Using base64url instead of `encodeURIComponent` matters because the encoded folder path can
 * contain `%2F` (the `/` separator URL-encoded). Some relative asset URLs in VS Code's HTML get
 * resolved by the browser against the page path, and the browser treats `%2F` as a directory
 * separator during resolution — so requests come back with the folder path _unencoded_, no longer
 * matching our base path, and 404. base64url has no `/`, `?`, or other reserved chars, so the
 * round-trip is stable.
 */
const proxyRoot = '/vscode-proxy';

function encodeFolderId(folder: string): string {
    return (
        Buffer.from(folder, 'utf-8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            /**
             * Base64 padding is at most 2 `=` chars; bound the quantifier so sonarjs/slow-regex is
             * happy.
             */
            .replace(/={0,2}$/, '')
    );
}

function decodeFolderId(id: string): string | undefined {
    try {
        const base64 = id.replace(/-/g, '+').replace(/_/g, '/');
        /** Pad to multiple of 4 so atob/Buffer accepts it. */
        const padding = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
        const decoded = Buffer.from(base64 + padding, 'base64').toString('utf-8');
        return decoded || undefined;
    } catch {
        return undefined;
    }
}

export function basePathForFolder(folder: string): string {
    return `${proxyRoot}/${encodeFolderId(folder)}`;
}

function decodeFolderFromUrl(url: string): string | undefined {
    if (!url.startsWith(`${proxyRoot}/`)) {
        return undefined;
    }
    const afterPrefix = url.slice(proxyRoot.length + 1);
    /** First segment is the folder id; the rest is forwarded to VS Code unchanged. */
    const slashIndex = afterPrefix.indexOf('/');
    const encodedFolder =
        slashIndex === -1
            ? afterPrefix.split('?')[0]?.split('#')[0]
            : afterPrefix.slice(0, slashIndex);
    if (!encodedFolder) {
        return undefined;
    }
    return decodeFolderId(encodedFolder);
}

function parseCookies(header: string | undefined): Record<string, string> {
    if (!header) {
        return {};
    }
    const out: Record<string, string> = {};
    header.split(';').forEach((part) => {
        const trimmed = part.trim();
        const eq = trimmed.indexOf('=');
        if (eq <= 0) {
            return;
        }
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (key) {
            try {
                out[key] = decodeURIComponent(value);
            } catch {
                out[key] = value;
            }
        }
    });
    return out;
}

function extractBearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== 'string') {
        return undefined;
    }
    const trimmed = header.trim();
    const schemePrefix = 'bearer ';
    if (trimmed.slice(0, schemePrefix.length).toLowerCase() !== schemePrefix) {
        return undefined;
    }
    return trimmed.slice(schemePrefix.length).trimStart() || undefined;
}

async function authorizeBearer(request: FastifyRequest): Promise<boolean> {
    const provided = extractBearerToken(request.headers.authorization);
    return await verifyAuthToken(provided);
}

async function authorizeCookie(headers: IncomingMessage['headers']): Promise<boolean> {
    const cookies = parseCookies(typeof headers.cookie === 'string' ? headers.cookie : undefined);
    const provided = cookies[vscodeBearerCookieName];
    if (!provided) {
        return false;
    }
    return await verifyAuthToken(provided);
}

function setBearerCookie(reply: FastifyReply, bearer: string): void {
    /**
     * `HttpOnly` keeps the cookie out of `document.cookie` (defense against XSS exfiltrating the
     * bearer). `SameSite=Lax` is enough since the iframe lives on the backend's origin and the
     * cookie only needs to ride along on requests _to_ the backend. Path-scoped to the proxy so it
     * never leaks onto unrelated endpoints.
     */
    reply.header(
        'set-cookie',
        [
            `${vscodeBearerCookieName}=${encodeURIComponent(bearer)}`,
            'HttpOnly',
            'SameSite=Lax',
            `Path=${proxyRoot}/`,
            'Max-Age=86400',
        ].join('; '),
    );
}

function clearBearerCookie(reply: FastifyReply): void {
    reply.header(
        'set-cookie',
        [
            `${vscodeBearerCookieName}=`,
            'HttpOnly',
            'SameSite=Lax',
            `Path=${proxyRoot}/`,
            'Max-Age=0',
        ].join('; '),
    );
}

/**
 * Look up the live port for a given folder by asking the daemon's `vscode-list` action. Returns
 * undefined when no VS Code instance is running for that folder.
 */
async function lookupPort(folder: string): Promise<number | undefined> {
    const list = await listVscode();
    return list.find((entry) => entry.folder === folder)?.port;
}

/**
 * CSS injected into the workbench HTML before `</head>` so we can hide UI chrome the embedded VS
 * Code surfaces that doesn't make sense inside the agent-storm iframe (most prominently the custom
 * title bar with command center + chat / account / settings icons, since the agent-storm tab strip
 * already handles window context).
 *
 * Use `visibility: hidden`, NOT `display: none`. The latter removes the titlebar from the layout
 * flow which perturbs VS Code's grid math in non-default activity-bar configurations (e.g. with
 * `workbench.activityBar.location: "bottom"` the bottom activity-bar strip and status bar fall off
 * the screen). `visibility: hidden` keeps the layout slot intact — the bar is just rendered blank,
 * and the iframe-side `--vscode-titlebar-offset` shift hides the now-empty space behind the
 * agent-storm tab strip.
 */
const workbenchCssInjection = `
.monaco-workbench .part.titlebar { visibility: hidden !important; }
`;

/**
 * Match the workbench HTML page. VS Code serves the main page at the server-base-path root, with
 * the encoded folder id immediately under `/vscode-proxy/`. Examples: /vscode-proxy/L1Vz...torm
 * /vscode-proxy/L1Vz...torm/ /vscode-proxy/L1Vz...torm?folder=...
 * /vscode-proxy/L1Vz...torm/?folder=... Static assets and API requests have additional path
 * segments after the folder id, so we anchor on "no more slashes after the folder id (before the
 * optional `?`)".
 */
function isWorkbenchHtmlRequest(request: FastifyRequest): boolean {
    if (request.method !== 'GET') {
        return false;
    }
    const url = request.url || '';
    return /^\/vscode-proxy\/[^/?]+\/?(?:\?.*)?$/.test(url);
}

/**
 * Forward an HTTP request to a child VS Code instance. We unconditionally strip hop-by-hop headers;
 * everything else (cookies, accept-encoding, user-agent, etc.) is passed through so the VS Code
 * frontend behaves identically to a direct browser connection. Exception: for the workbench HTML
 * page itself we strip Accept-Encoding so upstream returns plain text — that lets us buffer the
 * response and inject {@link workbenchCssInjection} before passing it along.
 */
function pipeHttp(request: FastifyRequest, reply: FastifyReply, port: number): void {
    /**
     * Hop-by-hop headers per RFC 7230 — these MUST NOT be forwarded by a reverse proxy. Note that
     * `host` is intentionally NOT in this set even though it's commonly stripped by naive proxies:
     * we need to forward the browser-supplied `Host` (e.g. `100.69.198.117:41880`) so VS Code uses
     * it as the `remoteAuthority` in the served workbench HTML. If `host` gets dropped, Node's
     * `http.request` defaults it back to `127.0.0.1:<vscode-port>` (the target address), which is
     * the bug that made the embedded WebSocket URLs bypass our proxy.
     */
    const hopByHop = new Set([
        'connection',
        'keep-alive',
        'proxy-authenticate',
        'proxy-authorization',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
    ]);
    const forwardHeaders: Record<string, string | string[]> = {};
    Object.entries(request.headers).forEach(
        ([
            key,
            value,
        ]) => {
            if (value !== undefined && !hopByHop.has(key.toLowerCase())) {
                forwardHeaders[key] = value;
            }
        },
    );

    const isHtmlPage = isWorkbenchHtmlRequest(request);
    if (isHtmlPage) {
        delete forwardHeaders['accept-encoding'];
    }

    const upstream = httpRequest(
        {
            host: '127.0.0.1',
            port,
            method: request.method,
            path: request.url,
            headers: forwardHeaders,
        },
        (upstreamRes) => {
            const contentType = upstreamRes.headers['content-type'] ?? '';
            if (isHtmlPage && contentType.toLowerCase().startsWith('text/html')) {
                const chunks: Buffer[] = [];
                upstreamRes.on('data', (chunk: Buffer) => chunks.push(chunk));
                upstreamRes.on('end', () => {
                    const original = Buffer.concat(chunks).toString('utf-8');
                    const injection = `<style>${workbenchCssInjection}</style>`;
                    const modified = original.includes('</head>')
                        ? original.replace('</head>', `${injection}</head>`)
                        : injection + original;
                    reply.status(upstreamRes.statusCode ?? 502);
                    Object.entries(upstreamRes.headers).forEach(
                        ([
                            key,
                            value,
                        ]) => {
                            if (value === undefined) {
                                return;
                            }
                            const lower = key.toLowerCase();
                            /**
                             * Skip content-length / content-encoding — we changed the body length
                             * and the response is now uncompressed regardless of what upstream
                             * said.
                             */
                            if (
                                hopByHop.has(lower) ||
                                lower === 'content-length' ||
                                lower === 'content-encoding'
                            ) {
                                return;
                            }
                            reply.header(key, value);
                        },
                    );
                    reply.send(modified);
                });
                upstreamRes.on('error', (error) => {
                    log.error(`vscode proxy html buffer error: ${error.message}`);
                    if (!reply.sent) {
                        reply.status(502).send({
                            error: 'VS Code upstream HTML error',
                        });
                    }
                });
                return;
            }
            reply.status(upstreamRes.statusCode ?? 502);
            Object.entries(upstreamRes.headers).forEach(
                ([
                    key,
                    value,
                ]) => {
                    if (value !== undefined && !hopByHop.has(key.toLowerCase())) {
                        reply.header(key, value);
                    }
                },
            );
            reply.send(upstreamRes);
        },
    );
    upstream.on('error', (error) => {
        log.error(`vscode proxy upstream error: ${error.message}`);
        if (!reply.sent) {
            reply.status(502).send({
                error: 'VS Code upstream unreachable',
            });
        }
    });
    request.raw.pipe(upstream);
}

/**
 * Forward a WebSocket upgrade request to a child VS Code instance by opening a raw TCP socket and
 * passing the HTTP/1.1 upgrade exchange + subsequent frames through. Lifted from the standard
 * recipe for hand-rolling a WS reverse proxy without pulling in `http-proxy` or `ws`.
 */
function pipeWebSocket(
    clientSocket: Socket,
    head: Buffer,
    request: IncomingMessage,
    port: number,
): void {
    log.info(`[vscode-ws] pipeWebSocket entry: ${request.method} ${request.url} → :${port}`);
    const upstreamSocket = netConnect({
        port,
        host: '127.0.0.1',
    });
    let upstreamBytes = 0;
    let clientBytes = 0;
    upstreamSocket.on('error', (error) => {
        log.error(`[vscode-ws] upstream error: ${error.message}`);
        clientSocket.destroy();
    });
    clientSocket.on('error', (error) => {
        log.error(`[vscode-ws] client error: ${error.message}`);
        upstreamSocket.destroy();
    });
    clientSocket.once('end', () => {
        log.info("[vscode-ws] client emitted 'end'");
    });
    upstreamSocket.once('end', () => {
        log.info("[vscode-ws] upstream emitted 'end'");
    });
    /**
     * Critical: VS Code's `code serve-web` waits for the request body to be fully delivered before
     * sending the 101 Switching Protocols response, even for an upgrade with no body. If our write
     * half to upstream gets half-closed (FIN) before that response, VS Code silently closes the
     * connection without responding. The default `.pipe()` propagates 'end' from source to dest,
     * which would shut down upstream's write half as soon as clientSocket emits 'end' — for some
     * reason (Node http parser behavior post-upgrade, fastify finalization, etc.) that fires almost
     * immediately on a forwarded upgrade. We disable end-propagation in both directions and rely on
     * `destroy()` on either side to tear down the pair.
     */
    upstreamSocket.once('connect', () => {
        clientSocket.setNoDelay(true);
        upstreamSocket.setNoDelay(true);
        const headerLines = [`${request.method} ${request.url} HTTP/1.1`];
        Object.entries(request.headers).forEach(
            ([
                key,
                value,
            ]) => {
                if (value === undefined) {
                    return;
                }
                if (Array.isArray(value)) {
                    value.forEach((entry) => headerLines.push(`${key}: ${entry}`));
                } else {
                    headerLines.push(`${key}: ${value}`);
                }
            },
        );
        headerLines.push('', '');
        upstreamSocket.write(headerLines.join('\r\n'));
        if (head.length) {
            upstreamSocket.write(head);
        }
        /**
         * Order matters: attach `.pipe()` BEFORE the 'data' listeners. Adding a 'data' listener
         * switches the stream into flowing mode immediately, and any chunks emitted synchronously
         * during that switch are delivered only to listeners attached up to that point. Attaching
         * pipe first guarantees pipe sees every chunk.
         */
        clientSocket.pipe(upstreamSocket, {
            end: false,
        });
        upstreamSocket.pipe(clientSocket, {
            end: false,
        });
        let upstreamChunks = 0;
        let clientChunks = 0;
        upstreamSocket.on('data', (chunk: Buffer) => {
            upstreamBytes += chunk.length;
            upstreamChunks += 1;
            if (upstreamChunks <= 3) {
                const preview = chunk
                    .subarray(0, 120)
                    .toString('utf-8')
                    .replace(/\r/g, String.raw`\r`)
                    .replace(/\n/g, String.raw`\n`);
                log.info(
                    `[vscode-ws] upstream→client #${upstreamChunks} +${chunk.length} ${preview}`,
                );
            }
        });
        clientSocket.on('data', (chunk: Buffer) => {
            clientBytes += chunk.length;
            clientChunks += 1;
            if (clientChunks <= 3) {
                log.info(`[vscode-ws] client→upstream #${clientChunks} +${chunk.length}`);
            }
        });
        const closeBoth = (origin: string) => () => {
            log.info(
                `[vscode-ws] ${origin} closed (upstream→client=${upstreamBytes}b, client→upstream=${clientBytes}b)`,
            );
            clientSocket.destroy();
            upstreamSocket.destroy();
        };
        clientSocket.once('close', closeBoth('client'));
        upstreamSocket.once('close', closeBoth('upstream'));
    });
}

/**
 * Apply CORS headers needed for `fetch` calls from the agent-storm frontend (different port than
 * the backend) to succeed with `credentials: 'include'`. The browser refuses the response if
 * `Access-Control-Allow-Origin` is `*` while credentials are sent, so we echo back the request's
 * `Origin`. The bearer + cookie auth is what actually gates access; this just keeps the browser
 * from refusing the response.
 */
function applyCorsHeaders(request: FastifyRequest, reply: FastifyReply): void {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    if (origin) {
        reply.header('access-control-allow-origin', origin);
        reply.header('vary', 'origin');
    }
    reply.header('access-control-allow-credentials', 'true');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-allow-headers', 'authorization, content-type');
}

export function attachVscodeProxy(server: FastifyInstance): void {
    /**
     * CORS preflight for `/vscode/ensure` and `/vscode/kill`. The proxy itself (`/vscode-proxy/*`)
     * is loaded as an iframe `src`, not a fetch, so it doesn't trigger preflight.
     */
    server.options('/vscode/ensure', (request, reply) => {
        applyCorsHeaders(request, reply);
        reply.status(204).send();
    });
    server.options('/vscode/kill', (request, reply) => {
        applyCorsHeaders(request, reply);
        reply.status(204).send();
    });

    /**
     * Bearer-auth'd "spawn or reuse" endpoint. The frontend calls this once per folder when the
     * user clicks the Code tab, getting back the proxy URL prefix to put in the iframe `src`. Side
     * effects: spawns the VS Code child process (via the daemon) if needed, sets the scoped cookie
     * so subsequent iframe requests authenticate.
     */
    server.post('/vscode/ensure', async (request, reply) => {
        applyCorsHeaders(request, reply);
        if (!(await authorizeBearer(request))) {
            return reply.status(401).send({
                error: 'Unauthorized',
            });
        }
        const body = request.body as {folder?: string} | undefined;
        const folder = body?.folder;
        if (!folder) {
            return reply.status(400).send({
                error: 'Missing folder.',
            });
        }
        const basePath = basePathForFolder(folder);
        try {
            await ensureVscode({
                folder,
                basePath,
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return reply.status(500).send({
                error: message,
            });
        }
        const bearer = extractBearerToken(request.headers.authorization);
        if (bearer) {
            setBearerCookie(reply, bearer);
        }
        return reply.send({
            basePath,
        });
    });

    /**
     * Kill the VS Code instance for a given folder. Called by the X button next to the Code tab and
     * by side-effecting endpoints (`/panes/kill`, `/worktrees/delete`) that should bring the
     * instance down alongside the panes.
     */
    server.post('/vscode/kill', async (request, reply) => {
        applyCorsHeaders(request, reply);
        if (!(await authorizeBearer(request))) {
            return reply.status(401).send({
                error: 'Unauthorized',
            });
        }
        const body = request.body as {folder?: string} | undefined;
        const folder = body?.folder;
        if (!folder) {
            return reply.status(400).send({
                error: 'Missing folder.',
            });
        }
        await killVscode({
            folder,
        });
        clearBearerCookie(reply);
        return reply.send({
            ok: true,
        });
    });

    /** Cookie-auth'd HTTP proxy for everything the VS Code web client requests. */
    server.all(`${proxyRoot}/*`, async (request, reply) => {
        if (!(await authorizeCookie(request.raw.headers))) {
            return reply.status(401).send({
                error: 'Unauthorized',
            });
        }
        const folder = decodeFolderFromUrl(request.url);
        if (!folder) {
            return reply.status(400).send({
                error: 'Bad proxy path.',
            });
        }
        const port = await lookupPort(folder);
        if (!port) {
            return reply.status(404).send({
                error: 'VS Code instance not running for folder.',
            });
        }
        pipeHttp(request, reply, port);
        /** `reply.send` was already called inside pipeHttp via the streamed response. */
        return reply;
    });

    /**
     * WebSocket upgrade dispatcher. `@fastify/websocket` (used by rest-vir) registers its own
     * 'upgrade' listener that grabs every upgrade socket — regardless of URL — and routes it
     * through fastify's HTTP router. If we only `.on('upgrade', …)` alongside it, both handlers run
     * for our `/vscode-proxy/*` upgrades and stomp on the same socket (fastify ends up writing a
     * 404 response while we write a 101 forwarded from VS Code), so the browser never gets a clean
     * WS handshake.
     *
     * We work around this by replacing the listener chain with a single dispatcher: our paths go to
     * `pipeWebSocket`, everything else (notably `/pty` from the rest-vir service) is forwarded to
     * the original `@fastify/websocket` listeners. This relies on `attachVscodeProxy` running after
     * `attachApi` so the existing listeners are already in place.
     */
    const existingUpgradeListeners = server.server.listeners('upgrade');
    server.server.removeAllListeners('upgrade');
    server.server.on('upgrade', (request, socket, head) => {
        if (request.url && request.url.startsWith(`${proxyRoot}/`)) {
            void (async () => {
                if (!(await authorizeCookie(request.headers))) {
                    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const folder = decodeFolderFromUrl(request.url || '');
                if (!folder) {
                    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
                    socket.destroy();
                    return;
                }
                const port = await lookupPort(folder);
                if (!port) {
                    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                    socket.destroy();
                    return;
                }
                pipeWebSocket(socket as Socket, head, request, port);
            })();
            return;
        }
        existingUpgradeListeners.forEach((listener) => {
            (listener as (...args: unknown[]) => unknown).call(
                server.server,
                request,
                socket,
                head,
            );
        });
    });
}
