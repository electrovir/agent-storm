import {BotAiRunStatus} from '@agent-storm/bot/src/protocol.js';
import {assert, check} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {
    findAiRunStop,
    findSpendBreach,
    isAiRunTimedOut,
    readBotLimits,
} from './bot-limits-check.js';

const botDefaults = {
    maxSpendPerDayUsd: 5,
    maxAiRunDuration: {
        minutes: 10,
    },
};

describe(readBotLimits.name, () => {
    it('keeps a spend override of 0 and falls back to the defaults for the rest', () => {
        assert.deepEquals(
            [
                readBotLimits({
                    overrides: {
                        maxSpendPerDayUsd: 0,
                        maxAiRunDuration: undefined,
                    },
                    defaults: botDefaults,
                }),
                readBotLimits({
                    overrides: undefined,
                    defaults: botDefaults,
                }),
            ],
            [
                {
                    maxSpendPerDayUsd: 0,
                    maxAiRunDuration: botDefaults.maxAiRunDuration,
                },
                botDefaults,
            ],
        );
    });
});

describe(findSpendBreach.name, () => {
    it('only allows a priced cost under the limit', () => {
        assert.deepEquals(
            [
                {
                    costUsd: 1.99,
                    hasUnpricedTokens: false,
                },
                {
                    costUsd: 2,
                    hasUnpricedTokens: false,
                },
                {
                    costUsd: 0,
                    hasUnpricedTokens: true,
                },
                undefined,
            ].map((cost) => {
                return check.isString(
                    findSpendBreach({
                        maxSpendPerDayUsd: 2,
                        cost,
                    }),
                );
            }),
            [
                false,
                true,
                true,
                true,
            ],
        );
    });
});

describe(isAiRunTimedOut.name, () => {
    it('times out once the duration has passed, and never without a duration or start', () => {
        const now = 600_000;
        assert.deepEquals(
            [
                isAiRunTimedOut({
                    maxAiRunDuration: botDefaults.maxAiRunDuration,
                    startedAt: 0,
                    now,
                }),
                isAiRunTimedOut({
                    maxAiRunDuration: botDefaults.maxAiRunDuration,
                    startedAt: 1,
                    now,
                }),
                isAiRunTimedOut({
                    maxAiRunDuration: undefined,
                    startedAt: 0,
                    now,
                }),
                isAiRunTimedOut({
                    maxAiRunDuration: botDefaults.maxAiRunDuration,
                    startedAt: undefined,
                    now,
                }),
            ],
            [
                true,
                false,
                false,
                false,
            ],
        );
    });
});

describe(findAiRunStop.name, () => {
    it('stops for the time limit before the spend limit', () => {
        assert.deepEquals(
            [
                findAiRunStop({
                    isTimedOut: true,
                    spendBreach: 'Over the limit.',
                })?.status,
                findAiRunStop({
                    isTimedOut: false,
                    spendBreach: 'Over the limit.',
                })?.status,
                findAiRunStop({
                    isTimedOut: false,
                    spendBreach: undefined,
                }),
            ],
            [
                BotAiRunStatus.TimedOut,
                BotAiRunStatus.OverSpendLimit,
                undefined,
            ],
        );
    });
});
