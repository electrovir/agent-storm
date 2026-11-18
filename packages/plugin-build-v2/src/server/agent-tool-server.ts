// cspell:word streamable
import {check} from '@augment-vir/assert';
import {extractErrorMessage, log} from '@augment-vir/common';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema, ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {type AnyDuration} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
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
 * Serves `tools` over MCP's streamable HTTP transport on a random localhost port. Each request's
 * bearer token picks the thread the tools act as.
 */
export async function startAgentToolServer({
    tools,
    context,
    instructions,
}: Readonly<{
    tools: ReadonlyArray<AgentTool>;
    context: AgentToolContext;
    /** What both providers show their agent about the tools as a whole. */
    instructions: string;
}>) {
    const threadIdsByToken = new Map<string, string>();
    const tokensByThreadId = new Map<string, string>();

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
                            readOnlyHint: tool.isReadOnly,
                        },
                    };
                }),
            };
        });
        mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const tool = tools.find((entry) => entry.name === request.params.name);
            try {
                if (!tool) {
                    throw new Error(`Agent Storm has no tool named ${request.params.name}.`);
                }
                const result = await tool.run({
                    callerId,
                    input: request.params.arguments || {},
                    context,
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
        const callerId = token ? threadIdsByToken.get(token) : undefined;
        if (!callerId) {
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

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || check.isString(address)) {
        throw new Error('The Agent Storm tool server did not get a port.');
    }
    const url = `http://127.0.0.1:${address.port}/mcp`;

    return {
        /** The connection a session of the thread uses, the same one each time. */
        connect(threadId: string) {
            const token = tokensByThreadId.get(threadId) || randomUUID();
            tokensByThreadId.set(threadId, token);
            threadIdsByToken.set(token, threadId);
            return {
                url,
                token,
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
