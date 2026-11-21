import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createFullDateInUserTimezone} from 'date-vir';
import {UsageProvider} from '../usage-api.js';
import {
    findAxisTicks,
    listRecentDays,
    shortenPrUrl,
    toProviderDailyValues,
    UsageMeasure,
} from './usage-chart.js';

const totals = {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    costUsd: 1.5,
    hasEstimatedCost: false,
    hasUnpricedTokens: false,
};

describe(listRecentDays.name, () => {
    it('ends with today and crosses month ends', () => {
        assert.deepEquals(
            listRecentDays(
                3,
                createFullDateInUserTimezone({
                    year: 2026,
                    month: 3,
                    day: 1,
                    hour: 12,
                    minute: 0,
                    second: 0,
                    millisecond: 0,
                    timezone: 'UTC',
                }),
            ),
            [
                '2026-02-27',
                '2026-02-28',
                '2026-03-01',
            ],
        );
    });
});

describe(toProviderDailyValues.name, () => {
    it('fills days without usage with zero', () => {
        assert.deepEquals(
            toProviderDailyValues({
                daily: [
                    {
                        day: '2026-11-19',
                        provider: UsageProvider.Codex,
                        totals,
                    },
                ],
                days: [
                    '2026-11-18',
                    '2026-11-19',
                ],
                measure: UsageMeasure.Tokens,
            }),
            [
                {
                    provider: UsageProvider.Claude,
                    values: [
                        0,
                        0,
                    ],
                },
                {
                    provider: UsageProvider.Codex,
                    values: [
                        0,
                        100,
                    ],
                },
            ],
        );
    });
});

describe(findAxisTicks.name, () => {
    it('rounds the top up to a round step', () => {
        assert.deepEquals(
            [
                findAxisTicks(7.3),
                findAxisTicks(0),
            ],
            [
                [
                    0,
                    2,
                    4,
                    6,
                    8,
                ],
                [
                    0,
                    1,
                ],
            ],
        );
    });
});

describe(shortenPrUrl.name, () => {
    it('shortens GitHub PR links only', () => {
        assert.deepEquals(
            [
                shortenPrUrl('https://github.com/owner/repo/pull/12'),
                shortenPrUrl('https://example.com/x'),
            ],
            [
                'owner/repo#12',
                'https://example.com/x',
            ],
        );
    });
});
