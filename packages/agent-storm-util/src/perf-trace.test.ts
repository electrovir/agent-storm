import {assert} from '@augment-vir/assert';
import {awaitedForEach, createArray, wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {startPerfTrace, takePerfTrace, tracePerfSpan} from './perf-trace.js';

describe(tracePerfSpan.name, () => {
    it('records spans into the trace its async context runs in', async () => {
        const traces = await Promise.all(
            [
                'first',
                'second',
            ].map(async (name) => {
                return await startPerfTrace(async () => {
                    await tracePerfSpan(name, () => {
                        return wait({
                            milliseconds: 5,
                        });
                    });
                    await tracePerfSpan(`${name} failure`, () => {
                        throw new Error('fails');
                    }).catch(() => undefined);
                    return takePerfTrace();
                });
            }),
        );
        assert.deepEquals(
            traces.map((trace) => {
                return trace?.spans.map((span) => {
                    return [
                        span.name,
                        span.isFailed,
                    ];
                });
            }),
            [
                [
                    [
                        'first',
                        false,
                    ],
                    [
                        'first failure',
                        true,
                    ],
                ],
                [
                    [
                        'second',
                        false,
                    ],
                    [
                        'second failure',
                        true,
                    ],
                ],
            ],
        );
    });

    it('stops recording once the trace is taken', async () => {
        const trace = await startPerfTrace(async () => {
            const taken = takePerfTrace();
            await tracePerfSpan('late', () => undefined);
            return taken;
        });
        assert.isLengthExactly(trace?.spans || [], 0);
        assert.isUndefined(
            startPerfTrace(() => {
                takePerfTrace();
                return takePerfTrace();
            }),
        );
    });

    it('counts spans past the cap instead of keeping them', async () => {
        const spanCount = 5000;
        const trace = await startPerfTrace(async () => {
            await awaitedForEach(
                createArray(spanCount, (index) => index),
                async (index) => {
                    await tracePerfSpan(`span ${index}`, () => undefined);
                },
            );
            return takePerfTrace();
        });
        assert.isAbove(trace?.droppedSpanCount ?? 0, 0);
        assert.strictEquals((trace?.spans.length ?? 0) + (trace?.droppedSpanCount ?? 0), spanCount);
    });
});
