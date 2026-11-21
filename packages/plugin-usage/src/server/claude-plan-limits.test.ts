import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {parseClaudePlanWindows} from './claude-plan-limits.js';

const emptyWindow = {
    utilization: null,
    resets_at: null,
};

describe(parseClaudePlanWindows.name, () => {
    it('keeps windows with a utilization, model windows last', () => {
        assert.deepEquals(
            parseClaudePlanWindows({
                five_hour: {
                    utilization: 4,
                    resets_at: '2026-11-20T03:30:00.000+00:00',
                },
                seven_day: {
                    utilization: 31,
                    resets_at: null,
                },
                seven_day_opus: emptyWindow,
                seven_day_sonnet: null,
                seven_day_oauth_apps: null,
                model_scoped: [
                    {
                        display_name: 'Fable',
                        utilization: 10,
                        resets_at: null,
                    },
                ],
            }),
            [
                {
                    windowId: 'five_hour',
                    label: '5-hour',
                    usedPercent: 4,
                    resetsAt: Date.parse('2026-11-20T03:30:00.000+00:00'),
                },
                {
                    windowId: 'seven_day',
                    label: 'Weekly',
                    usedPercent: 31,
                    resetsAt: undefined,
                },
                {
                    windowId: 'model:Fable',
                    label: 'Weekly Fable',
                    usedPercent: 10,
                    resetsAt: undefined,
                },
            ],
        );
    });
});
