import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {ReasoningEffort, type ProviderModel} from '../build-api.js';

export const reasoningEffortLabels: Record<ReasoningEffort, string> = {
    [ReasoningEffort.Low]: 'Low',
    [ReasoningEffort.Medium]: 'Medium',
    [ReasoningEffort.High]: 'High',
    [ReasoningEffort.ExtraHigh]: 'Extra High',
    [ReasoningEffort.Max]: 'Max',
    [ReasoningEffort.Ultra]: 'Ultra',
};

/** Keeps the levels a provider reported that Agent Storm knows, ordered from lowest to highest. */
export function parseReasoningEfforts(reported: ReadonlyArray<string> | undefined) {
    return getEnumValues(ReasoningEffort).filter((effort) => reported?.includes(effort));
}

/** The level a provider reported, when Agent Storm knows it. */
export function parseReasoningEffort(reported: string | null | undefined) {
    return reported && check.isEnumValue(reported, ReasoningEffort) ? reported : undefined;
}

/**
 * The effort a model runs at: the thread's `effort` when the model supports it, else the model's
 * own default. Undefined when the model has no effort setting or the provider names no default.
 */
export function readEffectiveEffort({
    model,
    effort,
}: Readonly<{
    model: Readonly<Pick<ProviderModel, 'supportedEfforts' | 'defaultEffort'>> | undefined;
    effort: ReasoningEffort | undefined;
}>) {
    return effort && model?.supportedEfforts.includes(effort)
        ? effort
        : model?.defaultEffort || undefined;
}
