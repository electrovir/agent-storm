// cspell:words dont
import {shellQuote} from '@augment-vir/common';
import {type BotAi, BotAiProvider} from './bot-ai.js';
import {type BotExecute} from './bot-definition.js';

/**
 * How each provider's CLI and chat invoke a skill, given its name and arguments.
 *
 * @category Internal
 */
export const skillInvocations: Readonly<Record<BotAiProvider, (skill: string) => string>> = {
    [BotAiProvider.Claude](skill) {
        return `/${skill}`;
    },
    [BotAiProvider.Codex](skill) {
        return `$${skill}`;
    },
};

/**
 * The message an AI run starts with: the prompt, or the skill invocation.
 *
 * @category Internal
 */
export function createAiText({
    execute,
    provider,
}: Readonly<{
    execute: Readonly<Pick<BotExecute, 'prompt' | 'skill'>>;
    provider: BotAiProvider;
}>) {
    return execute.prompt || skillInvocations[provider](execute.skill || '');
}

const commandBuilders: Readonly<
    Record<
        BotAiProvider,
        (
            params: Readonly<{
                execute: BotExecute;
                ai: BotAi;
            }>,
        ) => string[]
    >
> = {
    [BotAiProvider.Claude]({execute, ai}) {
        return [
            'claude',
            '--print',
            '--model',
            ai.model,
            ...(ai.effort
                ? [
                      '--effort',
                      ai.effort,
                  ]
                : []),
            '--permission-mode',
            'dontAsk',
            ...(execute.mcpServers
                ? [
                      '--mcp-config',
                      JSON.stringify({
                          mcpServers: execute.mcpServers,
                      }),
                      '--strict-mcp-config',
                  ]
                : []),
            ...(execute.additionalDirectories?.length
                ? [
                      '--add-dir',
                      ...execute.additionalDirectories,
                  ]
                : []),
            ...(execute.allowedTools?.length
                ? [
                      '--allowedTools',
                      ...execute.allowedTools,
                  ]
                : []),
            ...(execute.disallowedTools?.length
                ? [
                      '--disallowedTools',
                      ...execute.disallowedTools,
                  ]
                : []),
            /** The tool lists are variadic, so without this they swallow the prompt. */
            '--',
            createAiText({
                execute,
                provider: BotAiProvider.Claude,
            }),
        ];
    },
    [BotAiProvider.Codex]({execute, ai}) {
        if (
            execute.allowedTools?.length ||
            execute.disallowedTools?.length ||
            execute.additionalDirectories?.length
        ) {
            throw new Error(
                'Codex has no per-tool allowlist, so a Codex run cannot use allowedTools, disallowedTools, or additionalDirectories. Use a Claude model for this run.',
            );
        } else if (execute.mcpServers) {
            /** Codex reads MCP servers from its own `~/.codex/config.toml`, not per run. */
            throw new Error('A Codex run cannot use mcpServers.');
        } else {
            return [
                'codex',
                'exec',
                '--model',
                ai.model,
                ...(ai.effort
                    ? [
                          '--config',
                          `model_reasoning_effort="${ai.effort}"`,
                      ]
                    : []),
                createAiText({
                    execute,
                    provider: BotAiProvider.Codex,
                }),
            ];
        }
    },
};

/**
 * The shell command that runs `execute` once through the provider's CLI, without Agent Storm.
 *
 * @category Internal
 */
export function createAiCommand(
    params: Readonly<{
        execute: BotExecute;
        ai: BotAi;
    }>,
) {
    return commandBuilders[params.ai.provider](params).map(shellQuote).join(' ');
}
