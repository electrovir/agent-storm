import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {parseCodexRateLimits} from './codex-plan-limits.js';

describe(parseCodexRateLimits.name, () => {
    it('prefers the codex limit and labels windows by length', () => {
        assert.deepEquals(
            parseCodexRateLimits({
                rateLimits: {
                    planType: 'other',
                    primary: null,
                    secondary: null,
                },
                rateLimitsByLimitId: {
                    codex: {
                        limitId: 'codex',
                        planType: 'plus',
                        primary: {
                            usedPercent: 12,
                            resetsAt: 1_795_000_000,
                            windowDurationMins: 300,
                        },
                        secondary: {
                            usedPercent: 40,
                            resetsAt: null,
                            windowDurationMins: 10_080,
                        },
                    },
                },
            }),
            {
                planName: 'plus',
                windows: [
                    {
                        windowId: 'primary',
                        label: '5-hour',
                        usedPercent: 12,
                        resetsAt: 1_795_000_000_000,
                    },
                    {
                        windowId: 'secondary',
                        label: 'Weekly',
                        usedPercent: 40,
                        resetsAt: undefined,
                    },
                ],
            },
        );
    });

    it('rejects an unknown format', () => {
        assert.throws(() => parseCodexRateLimits({}));
    });
});
