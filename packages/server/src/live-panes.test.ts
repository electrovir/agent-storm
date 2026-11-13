import {PaneKind} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {toRecordedPanes, trackLivePanes, type TrackedPane} from './live-panes.js';

const trackedPane: TrackedPane = {
    folder: '/repo',
    kind: PaneKind.Ai,
    sessionId: 'tab-1',
    goneSinceMs: undefined,
    lastWorkingAtMs: 1000,
};

describe(trackLivePanes.name, () => {
    it('keeps a pane that just went away and forgets it once the grace period passes', () => {
        const afterGone = trackLivePanes({
            tracked: [
                trackedPane,
            ],
            live: [],
            nowMs: 1000,
        });
        assert.deepEquals(afterGone, [
            {
                ...trackedPane,
                goneSinceMs: 1000,
            },
        ]);
        assert.deepEquals(
            trackLivePanes({
                tracked: afterGone,
                live: [],
                nowMs: 1000 + 60_000,
            }),
            [],
        );
    });
    it('adds new live panes and clears the gone time of panes running again', () => {
        assert.deepEquals(
            trackLivePanes({
                tracked: [
                    {
                        ...trackedPane,
                        goneSinceMs: 1500,
                    },
                ],
                live: [
                    {
                        folder: '/repo',
                        kind: PaneKind.Ai,
                        sessionId: 'tab-1',
                        isWorking: false,
                    },
                    {
                        folder: '/repo',
                        kind: PaneKind.Shell,
                        sessionId: 'tab-1',
                        isWorking: false,
                    },
                ],
                nowMs: 2000,
            }),
            [
                trackedPane,
                {
                    folder: '/repo',
                    kind: PaneKind.Shell,
                    sessionId: 'tab-1',
                    goneSinceMs: undefined,
                    lastWorkingAtMs: undefined,
                },
            ],
        );
    });
});

describe(toRecordedPanes.name, () => {
    it('records a pane as working until it has been done for the whole grace period', () => {
        assert.deepEquals(
            [
                1000 + 5000,
                1000 + 60_000,
            ].map((nowMs) => {
                return toRecordedPanes({
                    tracked: [
                        trackedPane,
                    ],
                    nowMs,
                })[0]?.isWorking;
            }),
            [
                true,
                false,
            ],
        );
    });
});
