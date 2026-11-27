import {
    botCalls,
    type BotCallName,
    type BotCallRequest,
    type BotCallResponse,
} from '@agent-storm/bot/src/protocol.js';
import {assertWrap, check} from '@augment-vir/assert';
import {extractErrorMessage, HttpStatus, type MaybePromise} from '@augment-vir/common';
import {once} from 'node:events';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {assertValidShape} from 'object-shape-tester';

/** Larger than any prompt a bot sends, small enough that a runaway client can't fill memory. */
const maxBodyBytes = 4 * 1024 * 1024;

/** Answers each of the calls a bot run makes, for the run its token belongs to. */
export type BotCallHandlers<Run> = {
    [Name in BotCallName]: (
        params: Readonly<{
            run: Run;
            request: BotCallRequest<Name>;
        }>,
    ) => MaybePromise<BotCallResponse<Name>>;
};

class HttpError extends Error {
    public override readonly name = 'HttpError';
    constructor(
        public readonly statusCode: number,
        message: string,
    ) {
        super(message);
    }
}

async function readBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    const counts = {
        bytes: 0,
    };
    for await (const chunk of request) {
        const buffer = Buffer.from(assertWrap.instanceOf(chunk, Buffer));
        counts.bytes += buffer.byteLength;
        if (counts.bytes > maxBodyBytes) {
            throw new HttpError(HttpStatus.PayloadTooLarge, 'The request body is too large.');
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function sendJson({
    response,
    statusCode,
    body,
}: Readonly<{
    response: ServerResponse;
    statusCode: number;
    body: unknown;
}>) {
    response.writeHead(statusCode, {
        'content-type': 'application/json',
    });
    response.end(JSON.stringify(body));
}

/**
 * Starts the loopback server bot runs call while Agent Storm runs them. Only a run's own token
 * reaches its handlers.
 */
export async function startBotCallServer<Run>({
    findRun,
    handlers,
}: Readonly<{
    /** Undefined for a token that belongs to no running run. */
    findRun(token: string): Run | undefined;
    handlers: BotCallHandlers<Run>;
}>) {
    async function answer(request: IncomingMessage) {
        const name = request.url?.slice(1) || '';
        if (request.method !== 'POST' || !check.isKeyOf(name, botCalls)) {
            throw new HttpError(HttpStatus.NotFound, 'No such call.');
        }
        const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        const run = token ? findRun(token) : undefined;
        if (run == undefined) {
            throw new HttpError(HttpStatus.Unauthorized, 'The run is unknown or already ended.');
        }
        const body: unknown = JSON.parse(await readBody(request));
        assertValidShape(body, botCalls[name].requestShape);
        /** Each handler takes its own call's request, which the shape check above confirmed. */
        const handler = handlers[name] satisfies BotCallHandlers<any>[BotCallName] as (
            params: Readonly<{
                run: Run;
                request: unknown;
            }>,
        ) => MaybePromise<unknown>;
        return await handler({
            run,
            request: body,
        });
    }

    const server = createServer(async (request, response) => {
        try {
            sendJson({
                response,
                statusCode: HttpStatus.Ok,
                body: await answer(request),
            });
        } catch (error) {
            sendJson({
                response,
                statusCode: error instanceof HttpError ? error.statusCode : HttpStatus.BadRequest,
                body: {
                    error: extractErrorMessage(error),
                },
            });
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || check.isString(address)) {
        throw new Error('The bot call server has no port.');
    }

    return {
        url: `http://127.0.0.1:${address.port}`,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        },
    };
}
