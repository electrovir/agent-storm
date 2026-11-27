import {type PartialWithUndefined} from '@augment-vir/common';
import {defineShape, enumShape, nullableShape} from 'object-shape-tester';

/**
 * The agent CLI a bot's AI work runs in.
 *
 * @category Main
 */
export enum BotAiProvider {
    Claude = 'claude',
    Codex = 'codex',
}

/**
 * How hard the model thinks. Not every model accepts every level.
 *
 * @category Main
 */
export enum BotAiEffort {
    Low = 'low',
    Medium = 'medium',
    High = 'high',
    XHigh = 'xhigh',
    Max = 'max',
    Ultra = 'ultra',
}

/**
 * Runtime check for {@link BotAi}.
 *
 * @category Internal
 */
export const botAiShape = defineShape({
    provider: enumShape(BotAiProvider),
    /** The provider's own model id, such as `claude-opus-5-5` or `gpt-6-luna`. */
    model: '',
    /** The provider's default when omitted. */
    effort: nullableShape(enumShape(BotAiEffort)),
});

/**
 * Which model a bot's AI work runs on.
 *
 * @category Main
 */
export type BotAi = typeof botAiShape.runtimeType;

/**
 * Same as spreading `override` over `base`, except that an unset or empty field in `override` keeps
 * `base`'s.
 *
 * @category Internal
 */
export function mergeBotAi(
    base: Readonly<BotAi>,
    override: Readonly<PartialWithUndefined<BotAi>> | undefined,
) {
    return {
        provider: override?.provider || base.provider,
        model: override?.model || base.model,
        effort: override?.effort || base.effort,
    };
}
