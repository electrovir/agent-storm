import {type PartialWithUndefined} from '@augment-vir/common';
import {type AnyBotDefinition} from './bot-definition.js';
import {type StandalonePolicy} from './standalone-policy.js';

/**
 * The base name of the config file at a repo's root, before its extension: `.ts`, `.js`, `.json`,
 * `.yaml`, or `.toml`.
 *
 * @category Internal
 */
export const agentStormConfigBaseName = 'agent-storm.config';

/**
 * A repo's `agent-storm.config.*` file.
 *
 * @category Main
 */
export type AgentStormConfig = Readonly<
    {
        /**
         * Each bot by its name: letters, digits, and dashes. A string is a path, relative to the
         * config file, to a module whose default export is the bot, which is how a JSON, YAML, or
         * TOML config lists bots.
         */
        bots: Readonly<Record<string, string | AnyBotDefinition>>;
    } & PartialWithUndefined<{
        /** What Agent Storm-only calls do when a bot runs outside Agent Storm. */
        standalone: StandalonePolicy;
    }>
>;

/**
 * Types an `agent-storm.config.ts` file's default export.
 *
 * @category Main
 */
export function defineAgentStormConfig<const Config extends AgentStormConfig>(config: Config) {
    return config;
}
