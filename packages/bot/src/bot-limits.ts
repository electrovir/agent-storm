import {anyDurationShape} from 'date-vir';
import {defineShape, nullableShape} from 'object-shape-tester';

/**
 * Runtime check for {@link BotLimits}.
 *
 * @category Internal
 */
export const botLimitsShape = defineShape({
    /**
     * What the bot's AI runs and the threads it starts may cost, in US dollars, over any 24 hours.
     * Agent Storm stops the AI run that reaches it and starts no more AI runs or threads until
     * older spending ages out. Without the Usage plugin, or with a model Usage has no price for,
     * none start at all.
     */
    maxSpendPerDayUsd: nullableShape(0),
    /** Agent Storm stops an AI run that goes on longer than this. */
    maxAiRunDuration: nullableShape(anyDurationShape),
});

/**
 * Caps on a bot's AI work, which Agent Storm enforces and the Bots tab can override one by one.
 * They don't apply outside Agent Storm.
 *
 * @category Main
 */
export type BotLimits = typeof botLimitsShape.runtimeType;
