import {definePluginServerExportsKey} from '@agent-storm/common';
import {type PartialWithUndefined} from '@augment-vir/common';
import {type UsageProvider, type UsageSource, usagePluginId} from './usage-api.js';

/** Tokens one model spent on one AI run. */
export type UsageRecordInput = Readonly<
    {
        /** Recording the same key again replaces the earlier record instead of adding to it. */
        dedupeKey: string;
        source: UsageSource;
        provider: UsageProvider;
        model: string;
        /** Input tokens that weren't read from or written to the prompt cache. */
        inputTokens: number;
        /** Includes `reasoningTokens`. */
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        repoPath: string;
        folder: string;
    } & PartialWithUndefined<{
        reasoningTokens: number;
        /** What the provider says the run cost. Estimated from list prices when unset. */
        costUsd: number;
        /** Epoch milliseconds. Now when unset. */
        occurredAt: number;
        threadId: string;
        prUrl: string;
        /** A name for the thread or PR, shown in the breakdowns. */
        label: string;
    }>
>;

/** What the Usage plugin's server part gives the plugins that log usage into it. */
export type UsageServerExports = Readonly<{
    recordUsage(record: UsageRecordInput): Promise<void>;
    /**
     * Reads the provider's plan limits again soon, for a provider run that reported its rate limits
     * changed. Calls close together share one reading.
     */
    notifyRateLimitsChanged(provider: UsageProvider): void;
    /**
     * What the thread's AI runs since `since` (epoch milliseconds) cost. With `hasUnpricedTokens`,
     * some ran on a model with no known price, so the real cost is higher.
     */
    readThreadCost(
        params: Readonly<{threadId: string; since: number}>,
    ): Promise<{costUsd: number; hasUnpricedTokens: boolean}>;
}>;

/**
 * Lives apart from the server part, so a plugin that logs usage imports this without bundling the
 * Usage plugin's server.
 */
export const usageExportsKey = definePluginServerExportsKey<UsageServerExports>(usagePluginId);
