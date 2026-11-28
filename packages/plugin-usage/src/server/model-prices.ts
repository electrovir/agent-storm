// cspell:word ultrafast

import {check} from '@augment-vir/assert';
import {getObjectTypedEntries, mapObjectValues, typedObjectFromEntries} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {UsageSpeed} from '../usage-api.js';

/** USD per token. */
export type ModelPrice = Readonly<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}>;

export type ModelPrices = Readonly<Record<string, ModelPrice>>;

/** The community-kept LiteLLM list of model prices, the same list T3 Code prices usage with. */
const pricesUrl =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Picks each model's prices out of the LiteLLM list, skipping entries without token prices. */
export function parseModelPrices(list: unknown): ModelPrices {
    if (!check.isObject(list)) {
        throw new TypeError('The model price list is not an object.');
    }
    return typedObjectFromEntries(
        getObjectTypedEntries(list).flatMap(
            ([
                model,
                entry,
            ]) => {
                if (
                    !check.isObject(entry) ||
                    !check.isNumber(entry.input_cost_per_token) ||
                    !check.isNumber(entry.output_cost_per_token)
                ) {
                    return [];
                }
                return [
                    [
                        model,
                        {
                            input: entry.input_cost_per_token,
                            output: entry.output_cost_per_token,
                            cacheRead: check.isNumber(entry.cache_read_input_token_cost)
                                ? entry.cache_read_input_token_cost
                                : entry.input_cost_per_token,
                            cacheWrite: check.isNumber(entry.cache_creation_input_token_cost)
                                ? entry.cache_creation_input_token_cost
                                : entry.input_cost_per_token,
                        },
                    ] as const,
                ];
            },
        ),
    );
}

/**
 * Finds `model`'s prices under the names providers report it by, which can carry a context-window
 * suffix such as `[1m]` or a release date the list leaves off.
 */
export function findModelPrice(prices: ModelPrices, model: string): ModelPrice | undefined {
    const withoutSuffix =
        model.endsWith(']') && model.includes('[') ? model.slice(0, model.lastIndexOf('[')) : model;
    const withoutDate = withoutSuffix.replace(/-\d{8}$/, '');
    return [
        model,
        withoutSuffix,
        withoutDate,
    ]
        .map((name) => prices[name])
        .find(check.isDefined);
}

/**
 * Each speed's price as a multiple of the standard price, the only one the price list has. Both
 * Anthropic and OpenAI apply it to every kind of token, cache reads and writes included.
 */
const speedPriceMultipliers: Readonly<Record<UsageSpeed, number>> = {
    [UsageSpeed.Standard]: 1,
    [UsageSpeed.Fast]: 2,
    [UsageSpeed.Ultrafast]: 6,
};

/** OpenAI's launch price for Ultrafast on its GPT-6.2 models, per its API pricing page. */
const ultrafastLaunchPrice = {
    modelPrefix: 'gpt-6.2-',
    multiplier: 3,
    /** Epoch milliseconds: the start of March 1, 2027, Pacific time. */
    endsAt: Date.parse('2027-03-01T00:00:00-08:00'),
} as const;

/** What `speed` cost on `model` at `occurredAt` (epoch milliseconds), as a multiple of standard. */
export function findSpeedPriceMultiplier({
    model,
    speed,
    occurredAt,
}: Readonly<{
    model: string;
    speed: UsageSpeed;
    occurredAt: number;
}>) {
    return speed === UsageSpeed.Ultrafast &&
        model.startsWith(ultrafastLaunchPrice.modelPrefix) &&
        occurredAt < ultrafastLaunchPrice.endsAt
        ? ultrafastLaunchPrice.multiplier
        : speedPriceMultipliers[speed];
}

/** When the Ultrafast launch price ends, so records on either side of it price differently. */
export const speedPriceChangesAt = ultrafastLaunchPrice.endsAt;

export function estimateCost({
    price,
    model,
    speed,
    occurredAt,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
}: Readonly<{
    price: ModelPrice;
    model: string;
    speed: UsageSpeed;
    /** Epoch milliseconds. */
    occurredAt: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}>) {
    return (
        findSpeedPriceMultiplier({
            model,
            speed,
            occurredAt,
        }) *
        (inputTokens * price.input +
            outputTokens * price.output +
            cacheReadTokens * price.cacheRead +
            cacheWriteTokens * price.cacheWrite)
    );
}

/**
 * The model prices saved in `dataDir`, fetched again once they're a day old. Falls back to the
 * saved prices, however old, when the fetch fails, and to no prices without any saved.
 */
export async function loadModelPrices(dataDir: string): Promise<ModelPrices> {
    const cachePath = join(dataDir, 'model-prices.json');
    const cachedPrices = await readFile(cachePath, 'utf8')
        .then((contents) => {
            const cached: unknown = JSON.parse(contents);
            return check.isObject(cached) && check.isNumber(cached.fetchedAt)
                ? {
                      fetchedAt: cached.fetchedAt,
                      prices: parseModelPrices(cached.list),
                  }
                : undefined;
        })
        .catch(() => undefined);
    const maxAge = convertDuration(
        {
            days: 1,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    if (cachedPrices && Date.now() - cachedPrices.fetchedAt < maxAge) {
        return cachedPrices.prices;
    }
    try {
        const response = await fetch(pricesUrl, {
            headers: {
                'User-Agent': 'agent-storm-usage/0.1',
            },
            signal: AbortSignal.timeout(
                convertDuration(
                    {
                        seconds: 30,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds,
            ),
        });
        if (!response.ok) {
            throw new Error(`Fetching model prices failed with status ${response.status}.`);
        }
        const prices = parseModelPrices(await response.json());
        /** Saved in the LiteLLM list's own format, so a read parses it the same way as a fetch. */
        await writeFileAtomically({
            path: cachePath,
            contents: JSON.stringify({
                fetchedAt: Date.now(),
                list: mapObjectValues(prices, (model, price) => {
                    return {
                        input_cost_per_token: price.input,
                        output_cost_per_token: price.output,
                        cache_read_input_token_cost: price.cacheRead,
                        cache_creation_input_token_cost: price.cacheWrite,
                    };
                }),
            }),
        });
        return prices;
    } catch (error) {
        if (cachedPrices) {
            return cachedPrices.prices;
        }
        throw error;
    }
}
