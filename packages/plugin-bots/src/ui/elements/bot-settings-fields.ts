import {BotAiEffort, BotAiProvider} from '@agent-storm/bot/src/bot-ai.js';
import {providerLabels, RuntimeMode} from '@agent-storm/plugin-build/src/build-api.js';
import {check} from '@augment-vir/assert';
import {getEnumValues} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {ViraFormFieldType, type ViraFormField} from 'vira';
import {type BotInfo, type BotSettings} from '../../bots-api.js';
import {runtimeModeLabels} from './bots-display.js';

/** Each field of a bot's settings form. */
export enum BotSettingsField {
    IntervalMinutes = 'intervalMinutes',
    Provider = 'provider',
    Model = 'model',
    Effort = 'effort',
    RuntimeMode = 'runtimeMode',
    MaxSpendPerDayUsd = 'maxSpendPerDayUsd',
    MaxAiRunMinutes = 'maxAiRunMinutes',
    ApiKey = 'apiKey',
}

export type BotSettingsFields = Readonly<Record<BotSettingsField, ViraFormField>>;

function toMinutes(duration: BotInfo['defaultInterval']) {
    return convertDuration(duration, {
        minutes: true,
    }).minutes;
}

/** Holds only a key the user typed, since a saved key is never sent back to the browser. */
export function createApiKeyField({
    hasApiKey,
    typed,
}: Readonly<{
    hasApiKey: boolean;
    typed: string;
}>): ViraFormField {
    return {
        /**
         * Not a password field: Safari and password managers take any form holding one for a login
         * form, and offer saved logins on the number fields beside it.
         */
        type: ViraFormFieldType.Text,
        label: 'API key',
        value: typed,
        placeholder: hasApiKey
            ? 'Saved. Type a new one to replace it.'
            : "Unset, so the provider's own login applies.",
    };
}

/** The form for a bot's settings, filled in from what's saved. */
export function createBotSettingsFields(bot: Readonly<BotInfo>): BotSettingsFields {
    const defaultLabels = {
        provider: bot.defaultAi
            ? `${providerLabels[bot.defaultAi.provider]} (the bot's default)`
            : "The bot's default",
        effort: bot.defaultAi?.effort
            ? `${bot.defaultAi.effort} (the bot's default)`
            : "The model's default",
    };
    return {
        [BotSettingsField.IntervalMinutes]: {
            type: ViraFormFieldType.Number,
            label: 'Every how many minutes',
            value: bot.settings.interval ? toMinutes(bot.settings.interval) : undefined,
            placeholder: `${toMinutes(bot.defaultInterval)} (the bot's default)`,
            min: 1,
        },
        [BotSettingsField.Provider]: {
            type: ViraFormFieldType.Select,
            label: 'AI provider',
            value: bot.settings.ai?.provider || '',
            /** Vira shows the placeholder, not the empty option's label, while the value is empty. */
            placeholder: defaultLabels.provider,
            options: [
                {
                    value: '',
                    label: defaultLabels.provider,
                },
                ...getEnumValues(BotAiProvider).map((provider) => {
                    return {
                        value: provider,
                        label: providerLabels[provider],
                    };
                }),
            ],
        },
        [BotSettingsField.Model]: {
            type: ViraFormFieldType.Text,
            label: 'Model',
            value: bot.settings.ai?.model || '',
            placeholder: bot.defaultAi ? `${bot.defaultAi.model} (the bot's default)` : '',
        },
        [BotSettingsField.Effort]: {
            type: ViraFormFieldType.Select,
            label: 'Effort',
            value: bot.settings.ai?.effort || '',
            placeholder: defaultLabels.effort,
            options: [
                {
                    value: '',
                    label: defaultLabels.effort,
                },
                ...getEnumValues(BotAiEffort).map((effort) => {
                    return {
                        value: effort,
                        label: effort,
                    };
                }),
            ],
        },
        [BotSettingsField.RuntimeMode]: {
            type: ViraFormFieldType.Select,
            label: 'What AI runs may do without asking',
            value: bot.settings.runtimeMode,
            options: getEnumValues(RuntimeMode).map((mode) => {
                return {
                    value: mode,
                    label: runtimeModeLabels[mode],
                };
            }),
        },
        [BotSettingsField.MaxSpendPerDayUsd]: {
            type: ViraFormFieldType.Number,
            label: 'Most AI spend in any 24 hours, in USD',
            value: bot.settings.limits?.maxSpendPerDayUsd ?? undefined,
            placeholder:
                bot.defaultLimits?.maxSpendPerDayUsd == undefined
                    ? 'No limit'
                    : `${bot.defaultLimits.maxSpendPerDayUsd} (the bot's default)`,
            min: 0,
        },
        [BotSettingsField.MaxAiRunMinutes]: {
            type: ViraFormFieldType.Number,
            label: 'Most minutes one AI run may take',
            value: bot.settings.limits?.maxAiRunDuration
                ? toMinutes(bot.settings.limits.maxAiRunDuration)
                : undefined,
            placeholder: bot.defaultLimits?.maxAiRunDuration
                ? `${toMinutes(bot.defaultLimits.maxAiRunDuration)} (the bot's default)`
                : 'No limit',
            min: 1,
        },
        [BotSettingsField.ApiKey]: createApiKeyField({
            hasApiKey: bot.hasApiKey,
            typed: '',
        }),
    };
}

function readText(field: Readonly<ViraFormField>) {
    return check.isString(field.value) ? field.value.trim() : '';
}

/**
 * The settings the form holds, and the API key typed into it, if any. Whether the bot is enabled
 * stays as saved. Throws when the model override is missing a model.
 */
export function readBotSettingsFields({
    fields,
    bot,
}: Readonly<{
    fields: BotSettingsFields;
    bot: Readonly<BotInfo>;
}>) {
    const minutes = fields[BotSettingsField.IntervalMinutes].value;
    const provider = fields[BotSettingsField.Provider].value;
    const effort = fields[BotSettingsField.Effort].value;
    const runtimeMode = fields[BotSettingsField.RuntimeMode].value;
    const maxSpendPerDayUsd = fields[BotSettingsField.MaxSpendPerDayUsd].value;
    const maxAiRunMinutes = fields[BotSettingsField.MaxAiRunMinutes].value;
    const chosen = {
        provider: check.isEnumValue(provider, BotAiProvider) ? provider : undefined,
        model: readText(fields[BotSettingsField.Model]),
        effort: check.isEnumValue(effort, BotAiEffort) ? effort : undefined,
    };
    /** Another provider can't run the bot's default model. */
    const fallbackModel =
        !chosen.provider || chosen.provider === bot.defaultAi?.provider
            ? bot.defaultAi?.model || ''
            : '';
    const ai =
        chosen.provider || chosen.model || chosen.effort
            ? {
                  provider: chosen.provider || bot.defaultAi?.provider || BotAiProvider.Claude,
                  model: chosen.model || fallbackModel,
                  effort: chosen.effort || bot.defaultAi?.effort,
              }
            : undefined;
    if (ai && !ai.model) {
        throw new Error('Set a model to go with that provider.');
    }
    const settings: BotSettings = {
        isEnabled: bot.settings.isEnabled,
        interval:
            check.isNumber(minutes) && minutes > 0
                ? {
                      minutes,
                  }
                : undefined,
        ai,
        runtimeMode: check.isEnumValue(runtimeMode, RuntimeMode) ? runtimeMode : RuntimeMode.Auto,
        limits:
            check.isNumber(maxSpendPerDayUsd) || check.isNumber(maxAiRunMinutes)
                ? {
                      maxSpendPerDayUsd: check.isNumber(maxSpendPerDayUsd)
                          ? maxSpendPerDayUsd
                          : undefined,
                      maxAiRunDuration:
                          check.isNumber(maxAiRunMinutes) && maxAiRunMinutes > 0
                              ? {
                                    minutes: maxAiRunMinutes,
                                }
                              : undefined,
                  }
                : undefined,
    };
    return {
        settings,
        apiKey: readText(fields[BotSettingsField.ApiKey]) || undefined,
    };
}
