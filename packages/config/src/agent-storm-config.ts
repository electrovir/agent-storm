import {mapSchemaToShape, type JSONSchema} from 'schema-vir';

/**
 * The config file's path from a repo's root, before its extension: `.ts`, `.js`, `.json`, `.yaml`,
 * or `.toml`.
 *
 * @category Internal
 */
export const agentStormConfigBaseName = '.agent-storm/agent-storm.config';

/**
 * The JSON Schema of {@link AgentStormConfig}.
 *
 * @category Internal
 */
export const agentStormConfigJsonSchema = {
    type: 'object',
    additionalProperties: false,
    title: 'Agent Storm config',
    properties: {
        postWorktreeCmd: {
            type: 'string',
            title: 'Post-worktree command',
            description: "Shell command run in each new worktree. Overrides the user's default.",
        },
        reviewSkill: {
            type: 'string',
            title: 'Review skill',
            description:
                "Slash command, with any arguments, that Agent Storm's worktree skills review their work with before opening a PR, such as `/review-branch local`. Overrides the user's default.",
        },
        review: {
            type: 'object',
            additionalProperties: false,
            title: 'Review',
            properties: {
                initCmd: {
                    type: 'string',
                    title: 'Review init command',
                    description: 'Shell command run in each new review checkout of the repo.',
                },
            },
        },
        forges: {
            type: 'object',
            additionalProperties: false,
            title: 'Git forges',
            properties: {
                github: {
                    type: 'object',
                    additionalProperties: false,
                    title: 'GitHub',
                    properties: {
                        trustedBotLogins: {
                            type: 'array',
                            title: 'Trusted bots',
                            description:
                                "GitHub logins of bots to trust like repo collaborators, added to the user's own list.",
                            items: {
                                type: 'string',
                                title: 'Bot login',
                            },
                        },
                    },
                },
            },
        },
        bots: {
            type: 'object',
            title: 'Bots',
            description:
                "Each bot by its name: letters, digits, and dashes. A string is a path, relative to the config file, to a module whose default export is the bot, which is how a JSON, YAML, or TOML config lists bots. Only the repo root's file lists bots, and `@agent-storm/bot` checks each one when it loads.",
            additionalProperties: {
                anyOf: [
                    {
                        type: 'string',
                        title: 'Bot module path',
                    },
                    {
                        type: 'object',
                        additionalProperties: true,
                        title: 'Bot',
                    },
                ],
            },
        },
        standalone: {
            type: 'object',
            additionalProperties: false,
            title: 'Standalone policy',
            description:
                "What a bot's Agent Storm-only calls do when it runs outside Agent Storm. `@agent-storm/bot` checks the values.",
            properties: {
                question: {
                    type: 'string',
                    title: 'Question',
                },
                thread: {
                    type: 'string',
                    title: 'Thread',
                },
            },
        },
    },
} as const satisfies JSONSchema;

/**
 * Runtime check for {@link AgentStormConfig}.
 *
 * @category Internal
 */
export const agentStormConfigShape = mapSchemaToShape(agentStormConfigJsonSchema);

/**
 * A repo's `.agent-storm/agent-storm.config.*` file. Every key is optional. Its folder settings
 * apply to every folder from the file's own up to the home folder, the nearest file's winning,
 * while only the repo root's file lists bots.
 *
 * @category Internal
 */
export type AgentStormConfig = typeof agentStormConfigShape.runtimeType;

/**
 * Types a `.agent-storm/agent-storm.config.ts` file's default export, the same as `satisfies
 * AgentStormConfig`.
 *
 * @category Main
 */
export function defineAgentStormConfig<const Config extends AgentStormConfig>(config: Config) {
    return config;
}
