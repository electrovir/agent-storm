import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {ReasoningEffort} from '../build-api.js';
import {
    parseReasoningEffort,
    parseReasoningEfforts,
    readEffectiveEffort,
} from './reasoning-effort.js';

describe(parseReasoningEfforts.name, () => {
    it('keeps known levels in order and drops unknown ones', () => {
        assert.deepEquals(
            parseReasoningEfforts([
                'max',
                'minimal',
                'low',
                'xhigh',
            ]),
            [
                ReasoningEffort.Low,
                ReasoningEffort.ExtraHigh,
                ReasoningEffort.Max,
            ],
        );
    });

    it('reads a missing list as no levels', () => {
        assert.deepEquals(parseReasoningEfforts(undefined), []);
    });
});

describe(parseReasoningEffort.name, () => {
    it('reads a known level and rejects others', () => {
        assert.strictEquals(parseReasoningEffort('high'), ReasoningEffort.High);
        assert.isUndefined(parseReasoningEffort('minimal'));
        assert.isUndefined(parseReasoningEffort(null));
    });
});

describe(readEffectiveEffort.name, () => {
    const model = {
        supportedEfforts: [
            ReasoningEffort.Low,
            ReasoningEffort.High,
        ],
        defaultEffort: ReasoningEffort.Low,
    };

    it('uses a supported choice', () => {
        assert.strictEquals(
            readEffectiveEffort({
                model,
                effort: ReasoningEffort.High,
            }),
            ReasoningEffort.High,
        );
    });

    it('falls back to the default for an unsupported or missing choice', () => {
        assert.strictEquals(
            readEffectiveEffort({
                model,
                effort: ReasoningEffort.Max,
            }),
            ReasoningEffort.Low,
        );
        assert.strictEquals(
            readEffectiveEffort({
                model,
                effort: undefined,
            }),
            ReasoningEffort.Low,
        );
    });

    it('has no effort for a model without effort support', () => {
        assert.isUndefined(
            readEffectiveEffort({
                model: {
                    supportedEfforts: [],
                    defaultEffort: undefined,
                },
                effort: ReasoningEffort.High,
            }),
        );
    });
});
