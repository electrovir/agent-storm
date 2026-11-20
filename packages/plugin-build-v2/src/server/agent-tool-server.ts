// cspell:word streamable
import {check} from '@augment-vir/assert';
import {extractErrorMessage, log} from '@augment-vir/common';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {type AnyDuration} from 'date-vir';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {join} from 'node:path';
import {checkValidShape, defineShape} from 'object-shape-tester';
import {type AgentTool, type AgentToolContext} from './agent-tools.js';

/** The MCP server name both providers list Agent Storm's tools under. */
export const agentToolServerName = 'agent-storm';

/** Long enough for a tool that creates a worktree to wait out its post-worktree command. */
export const agentToolTimeout = {
    minutes: 10,
} as const satisfies AnyDuration;

/** How one thread's provider session reaches the tool server as that thread. */
export type AgentToolConnection = Readonly<{
    url: string;
    /** Identifies the calling thread. Sent as a bearer token. */
    token: string;
}>;

/**
 * What lets a provider process started before a restart keep reaching the tools: the port it was
 * given and the secret its token was signed with.
 */
const savedServerShape = defineShape({
    port: 0,
    secret: '',
});

async function readSavedServer(path: string) {
    try {
        const saved: unknown = JSON.parse(await readFile(path, 'utf-8'));
        return checkValidShape(saved, savedServerShape) ? saved : undefined;
    } catch {
        return undefined;
    }
}

async function listen(httpServer: Server, port: number) {
    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, '127.0.0.1', () => {
            httpServer.off('error', reject);
            resolve();
        });
    });
}

/**
 * Serves `tools` over MCP's streamable HTTP transport on localhost, on the same port as the last
 * run when it is still free. Each request's bearer token picks the thread the tools act as, and
 * stays valid across restarts.
 */
export async function startAgentToolServer({
    tools,
    context,
    instructions,
    dataDir,
}: Readonly<{
    tools: ReadonlyArray<AgentTool>;
    context: AgentToolContext;
    /** What both providers show their agent about the tools as a whole. */
    instructions: string;
    /** Where the port and token secret are kept between runs. */
    dataDir: string;
}>) {
    const savedServerPath = join(dataDir, 'agent-tool-server.json');
    const savedServer = await readSavedServer(savedServerPath);
    const secret = savedServer?.secret || randomBytes(32).toString('hex');

    function signThreadId(threadId: string) {
        return createHmac('sha256', secret).update(threadId).digest('hex');
    }

    /** The thread a `<thread id>.<signature>` token names, when its signature is valid. */
    function readTokenThreadId(token: string) {
        const separatorIndex = token.lastIndexOf('.');
        const threadId = token.slice(0, separatorIndex);
        const signature = Buffer.from(token.slice(separatorIndex + 1));
        const expected = Buffer.from(signThreadId(threadId));
        return separatorIndex > 0 &&
            signature.length === expected.length &&
            timingSafeEqual(signature, expected)
            ? threadId
            : undefined;
    }

    function createMcpServer(callerId: string) {
        const mcpServer = new McpServer(
            {
                name: agentToolServerName,
                version: '0.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
                instructions,
            },
        );
        /** The low-level handlers take JSON Schema, where `registerTool` takes zod schemas. */
        mcpServer.server.setRequestHandler(ListToolsRequestSchema, () => {
            return {
                tools: tools.map((tool) => {
                    return {
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        /** Codex asks the user before any tool without this hint. */
                        annotations: {
                            readOnlyHint: tool.isReadOnly || !!tool.asksForApproval,
                        },
                    };
                }),
            };
        });
        mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request, {signal}) => {
            const tool = tools.find((entry) => entry.name === request.params.name);
            try {
                if (!tool) {
                    throw new Error(`Agent Storm has no tool named ${request.params.name}.`);
                }
                const result = await tool.run({
                    callerId,
                    input: request.params.arguments || {},
                    context,
                    signal,
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, undefined, 4),
                        },
                    ],
                };
            } catch (error) {
                return {
                    isError: true,
                    content: [
                        {
                            type: 'text',
                            text: extractErrorMessage(error),
                        },
                    ],
                };
            }
        });
        return mcpServer;
    }

    const httpServer = createServer(async (request, response) => {
        const token = request.headers.authorization?.replace(/^Bearer /, '');
        const callerId = token ? readTokenThreadId(token) : undefined;
        /** `findThread` throws for an archived or deleted thread, whose token then stops working. */
        const isCallerActive =
            !!callerId &&
            (await context.findThread(callerId).then(
                () => true,
                () => false,
            ));
        if (!callerId || !isCallerActive) {
            response.writeHead(401).end();
            return;
        }
        const mcpServer = createMcpServer(callerId);
        /** Stateless: each request gets its own server, bound to the caller's thread. */
        const transport = new StreamableHTTPServerTransport({
            enableJsonResponse: true,
        });
        response.on('close', async () => {
            await transport.close();
            await mcpServer.close();
        });
        try {
            await mcpServer.connect(transport);
            await transport.handleRequest(request, response);
        } catch (error) {
            log.warning(`An Agent Storm tool request failed: ${extractErrorMessage(error)}`);
            if (!response.headersSent) {
                response.writeHead(500).end();
            }
        }
    });

    try {
        await listen(httpServer, savedServer?.port || 0);
    } catch {
        /** Something else took the port, so sessions from the last run lose the tools. */
        await listen(httpServer, 0);
    }
    const address = httpServer.address();
    if (!address || check.isString(address)) {
        throw new Error('The Agent Storm tool server did not get a port.');
    }
    await writeFile(
        savedServerPath,
        JSON.stringify({
            port: address.port,
            secret,
        }),
        {
            mode: 0o600,
        },
    );
    const url = `http://127.0.0.1:${address.port}/mcp`;

    return {
        /** The connection a session of the thread uses, the same one each time. */
        connect(threadId: string) {
            return {
                url,
                token: `${threadId}.${signThreadId(threadId)}`,
            };
        },
        async stop() {
            httpServer.closeAllConnections();
            await new Promise<void>((resolve) => {
                httpServer.close(() => resolve());
            });
        },
    };
}
