// cspell:word ultrafast

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {UsageSpeed} from '../usage-api.js';
import {estimateCost, findModelPrice, parseModelPrices} from './model-prices.js';

const prices = parseModelPrices({
    'claude-opus-5': {
        input_cost_per_token: 0.000005,
        output_cost_per_token: 0.000025,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
    },
    'gpt-5.5': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000008,
    },
    'image-model': {
        output_cost_per_image: 0.04,
    },
    sample_spec: 'not a model',
});

describe(parseModelPrices.name, () => {
    it('keeps models with token prices and prices missing cache rates as input', () => {
        assert.deepEquals(prices['gpt-5.5'], {
            input: 0.000001,
            output: 0.000008,
            cacheRead: 0.000001,
            cacheWrite: 0.000001,
        });
        assert.isUndefined(prices['image-model']);
    });
});

describe(findModelPrice.name, () => {
    it('finds a model named with a context suffix or a release date', () => {
        assert.deepEquals(
            [
                findModelPrice(prices, 'claude-opus-5[1m]'),
                findModelPrice(prices, 'claude-opus-5-20261101'),
                findModelPrice(prices, 'unknown-model'),
            ],
            [
                prices['claude-opus-5'],
                prices['claude-opus-5'],
                undefined,
            ],
        );
    });
});

describe(estimateCost.name, () => {
    it('prices each kind of token at its own rate, scaled by speed', () => {
        const beforeLaunchPriceEnds = Date.parse('2026-11-27T12:00:00Z');
        assert.deepEquals(
            [
                {
                    model: 'gpt-6-astra',
                    speed: UsageSpeed.Standard,
                    occurredAt: beforeLaunchPriceEnds,
                },
                {
                    model: 'gpt-6-astra',
                    speed: UsageSpeed.Fast,
                    occurredAt: beforeLaunchPriceEnds,
                },
                {
                    model: 'gpt-6-astra',
                    speed: UsageSpeed.Ultrafast,
                    occurredAt: beforeLaunchPriceEnds,
                },
                {
                    model: 'gpt-6.2-sol',
                    speed: UsageSpeed.Ultrafast,
                    occurredAt: beforeLaunchPriceEnds,
                },
                {
                    model: 'gpt-6.2-sol',
                    speed: UsageSpeed.Ultrafast,
                    occurredAt: Date.parse('2027-03-01T08:00:00Z'),
                },
            ].map((usage) => {
                return estimateCost({
                    ...usage,
                    price: {
                        input: 1,
                        output: 10,
                        cacheRead: 100,
                        cacheWrite: 1000,
                    },
                    inputTokens: 1,
                    outputTokens: 2,
                    cacheReadTokens: 3,
                    cacheWriteTokens: 4,
                });
            }),
            [
                4321,
                8642,
                25_926,
                12_963,
                25_926,
            ],
        );
    });
});
