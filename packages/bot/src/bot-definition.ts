import {assert, check} from '@augment-vir/assert';
import {
    type MaybePromise,
    type PartialWithUndefined,
    type RequireExactlyOne,
} from '@augment-vir/common';
import {type ArgDefinitions, type ParsedArgs} from 'cli-vir';
import {type AnyDuration, anyDurationShape, convertDuration} from 'date-vir';
import {assertValidShape, defineShape} from 'object-shape-tester';
import {type AgentStormClient} from './agent-storm-client.js';
import {type BotAi, botAiShape} from './bot-ai.js';
import {type StandalonePolicy, standalonePolicyShape} from './standalone-policy.js';

/**
 * What a bot asks the model to do for one AI run.
 *
 * @category Main
 */
export type BotExecute = RequireExactlyOne<{
    prompt: string;
    /** A skill name, followed by its arguments, without Claude's `/` or Codex's `$`. */
    skill: string;
}> &
    PartialWithUndefined<{
        /** Overrides the bot's {@link BotDefinition.ai} for this one run. */
        ai: BotAi;
        /**
         * Claude permission rules (`Read`, `Bash(git log *)`, `Edit(.not-committed/**)`) for the
         * tools this run may use. Every other tool is denied without a prompt, since nobody is at
         * the terminal to answer one. Codex has no per-tool allowlist, so a Codex run that sets
         * this throws. Inside Agent Storm, the Bots tab's runtime mode governs tools instead.
         */
        allowedTools: ReadonlyArray<string>;
        /** Claude permission rules denied even when an `allowedTools` rule matches. */
        disallowedTools: ReadonlyArray<string>;
        /** Directories outside the repo this run may use. */
        additionalDirectories: ReadonlyArray<string>;
        /**
         * The run's entire MCP configuration, keyed by server name, so the repo's `.mcp.json` is
         * ignored. Claude only. Inside Agent Storm, the repo's own MCP servers apply instead.
         */
        mcpServers: Readonly<
            Record<
                string,
                Readonly<{
                    command: string;
                    args: ReadonlyArray<string>;
                }>
            >
        >;
        /** Extra environment variables for this run's model, on top of the bot's `env`. */
        env: Readonly<Record<string, string>>;
    }>;

/**
 * The run a bot's setup function is part of.
 *
 * @category Main
 */
export type BotRun = Readonly<{
    botName: string;
    /**
     * Which call of the setup this is within the run: 0 first, then one more after each AI run. Use
     * it to tell a fresh run from a follow-up that should read the AI's result.
     */
    pass: number;
    /**
     * Adds a line to this run's entry in the Bots tab's run history, and logs it. A run that never
     * reports and never runs AI is recorded as having nothing to do.
     */
    report(line: string): Promise<void>;
}>;

/**
 * Does a bot's script work, then picks what the model does, if anything. Returning `undefined`
 * skips the model for this pass, so a bot only spends tokens when something needs judgment. After
 * each AI run the setup is called again, up to a few times, so the AI's result can be acted on
 * within the same run.
 *
 * @category Main
 */
export type BotSetup<Args extends ArgDefinitions> = (
    params: Readonly<{
        args: ParsedArgs<Args>;
        agentStorm: AgentStormClient;
        run: BotRun;
    }>,
) => MaybePromise<BotExecute | undefined>;

/**
 * A bot: a script that runs on an interval and calls AI only when needed.
 *
 * @category Main
 */
export type BotDefinition<Args extends ArgDefinitions = ArgDefinitions> = {
    /** Shown in Agent Storm's Bots tab. */
    description: string;
    /** How long from the start of one run to the next. The Bots tab can override it. */
    interval: AnyDuration;
    /** The model the bot's AI work runs on. The Bots tab can override it. */
    ai: BotAi;
    execute: BotExecute | BotSetup<Args>;
} & PartialWithUndefined<{
    /** Everything the bot accepts after its name on the `agent-storm-bot` command line. */
    args: Args;
    /** Extra environment variables for the model, on top of this process's own. */
    env: Readonly<Record<string, string>>;
    /** Overrides the config's {@link StandalonePolicy} for this bot. */
    standalone: StandalonePolicy;
}>;

/**
 * Any bot, whatever args it takes. Generic code that runs many bots can't know each one's args, so
 * this widens them.
 *
 * @category Internal
 */
export type AnyBotDefinition = BotDefinition<any>;

const botDefinitionShape = defineShape({
    description: '',
    interval: anyDurationShape,
    ai: botAiShape,
});

/**
 * Throws when `bot` isn't a bot definition, such as a module whose default export is something
 * else.
 *
 * @category Internal
 */
export function assertBotDefinition(bot: unknown): asserts bot is AnyBotDefinition {
    assertValidShape(bot, botDefinitionShape, {
        allowExtraKeys: true,
    });
    assert.isObject(bot);
    if (check.hasKey(bot, 'standalone') && bot.standalone != undefined) {
        assertValidShape(bot.standalone, standalonePolicyShape);
    }
    assert.isTrue(
        check.hasKey(bot, 'execute') &&
            (check.isFunction(bot.execute) ||
                (check.isObject(bot.execute) &&
                    (check.isString(bot.execute.prompt) || check.isString(bot.execute.skill)))),
        'A bot needs an `execute` function, or an `execute` object with a `prompt` or a `skill`.',
    );
    assert.isAbove(
        convertDuration(bot.interval, {
            milliseconds: true,
        }).milliseconds,
        0,
        'A bot needs an interval longer than zero.',
    );
}

/**
 * Defines a bot, typing its setup function's `args` from its `args` definitions.
 *
 * @category Main
 */
export function defineBot<const Args extends ArgDefinitions = Record<string, never>>(
    bot: BotDefinition<Args>,
) {
    assertBotDefinition(bot);
    return bot;
}
