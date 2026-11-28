import {type BotLimits} from '@agent-storm/bot/src/bot-limits.js';
import {BotAiRunStatus, type EndedBotAiRunStatus} from '@agent-storm/bot/src/protocol.js';
import {type AnyDuration, convertDuration} from 'date-vir';

/** Each of the bot's own limits, unless its settings override it. A spend override of 0 wins. */
export function readBotLimits({
    overrides,
    defaults,
}: Readonly<{
    overrides: Readonly<BotLimits> | null | undefined;
    defaults: Readonly<BotLimits> | null | undefined;
}>) {
    return {
        maxSpendPerDayUsd: overrides?.maxSpendPerDayUsd ?? defaults?.maxSpendPerDayUsd,
        maxAiRunDuration: overrides?.maxAiRunDuration || defaults?.maxAiRunDuration,
    };
}

/**
 * Why a bot that spent `cost` in the last 24 hours can't run more AI, if it can't. `cost` is
 * undefined without the Usage plugin.
 */
export function findSpendBreach({
    maxSpendPerDayUsd,
    cost,
}: Readonly<{
    maxSpendPerDayUsd: number;
    cost: Readonly<{costUsd: number; hasUnpricedTokens: boolean}> | undefined;
}>) {
    if (!cost) {
        return 'Turn on Usage, which checks the spend limit, for this bot to run AI.';
    } else if (cost.hasUnpricedTokens) {
        return "The bot's AI ran on a model Usage has no price for, so its spend limit can't be checked.";
    } else if (cost.costUsd >= maxSpendPerDayUsd) {
        return `The bot's AI cost $${cost.costUsd.toFixed(2)} in the last 24 hours, reaching its $${maxSpendPerDayUsd} limit.`;
    } else {
        return undefined;
    }
}

/** Whether an AI run that started at `startedAt` went past `maxAiRunDuration`. */
export function isAiRunTimedOut({
    maxAiRunDuration,
    startedAt,
    now,
}: Readonly<{
    maxAiRunDuration: Readonly<AnyDuration> | null | undefined;
    /** Epoch milliseconds. */
    startedAt: number | undefined;
    /** Epoch milliseconds. */
    now: number;
}>) {
    return (
        !!maxAiRunDuration &&
        startedAt != undefined &&
        now - startedAt >=
            convertDuration(maxAiRunDuration, {
                milliseconds: true,
            }).milliseconds
    );
}

/**
 * How Agent Storm stops an AI run that hit one of its bot's limits, if it did. The time limit wins
 * over the spend limit.
 *
 * Annotated because the statuses would otherwise widen to every {@link BotAiRunStatus}.
 */
export function findAiRunStop({
    isTimedOut,
    spendBreach,
}: Readonly<{
    isTimedOut: boolean;
    spendBreach: string | undefined;
}>): Readonly<{status: EndedBotAiRunStatus; reason: string}> | undefined {
    if (isTimedOut) {
        return {
            status: BotAiRunStatus.TimedOut,
            reason: 'The AI run went past its time limit, so Agent Storm stopped it.',
        };
    } else if (spendBreach) {
        return {
            status: BotAiRunStatus.OverSpendLimit,
            reason: `${spendBreach} Agent Storm stopped the AI run.`,
        };
    } else {
        return undefined;
    }
}
