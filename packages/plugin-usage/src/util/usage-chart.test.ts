// cspell:word ultrafast

import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createFullDateInUserTimezone} from 'date-vir';
import {UsageProvider, UsageSpeed} from '../usage-api.js';
import {listRecentDays, shortenPrUrl, toSpeedDailyValues, UsageMeasure} from './usage-chart.js';

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

describe(toSpeedDailyValues.name, () => {
    it('lists every speed each provider offers and fills days without usage with zero', () => {
        assert.deepEquals(
            toSpeedDailyValues({
                daily: [
                    {
                        day: '2026-11-19',
                        provider: UsageProvider.Codex,
                        speed: UsageSpeed.Ultrafast,
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
                    speed: UsageSpeed.Standard,
                    values: [
                        0,
                        0,
                    ],
                },
                {
                    provider: UsageProvider.Claude,
                    speed: UsageSpeed.Fast,
                    values: [
                        0,
                        0,
                    ],
                },
                {
                    provider: UsageProvider.Codex,
                    speed: UsageSpeed.Standard,
                    values: [
                        0,
                        0,
                    ],
                },
                {
                    provider: UsageProvider.Codex,
                    speed: UsageSpeed.Fast,
                    values: [
                        0,
                        0,
                    ],
                },
                {
                    provider: UsageProvider.Codex,
                    speed: UsageSpeed.Ultrafast,
                    values: [
                        0,
                        100,
                    ],
                },
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
