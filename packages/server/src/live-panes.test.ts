import {PaneKind} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {parseRecordedPanes, trackLivePanes, type TrackedPane} from './live-panes.js';

const trackedPane: TrackedPane = {
    folder: '/repo',
    kind: PaneKind.Shell,
    sessionId: 'tab-1',
    goneSinceMs: undefined,
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
                        kind: PaneKind.Shell,
                        sessionId: 'tab-1',
                    },
                    {
                        folder: '/repo',
                        kind: PaneKind.Shell,
                        sessionId: 'tab-2',
                    },
                ],
                nowMs: 2000,
            }),
            [
                trackedPane,
                {
                    folder: '/repo',
                    kind: PaneKind.Shell,
                    sessionId: 'tab-2',
                    goneSinceMs: undefined,
                },
            ],
        );
    });

    it('keeps panes distinct when colons appear in folders and session ids', () => {
        const tracked = {
            ...trackedPane,
            sessionId: `other:${trackedPane.kind}:${trackedPane.sessionId}`,
        };
        const added = {
            ...trackedPane,
            folder: `${trackedPane.folder}:${trackedPane.kind}:other`,
        };
        const nowMs = 2000;
        assert.deepEquals(
            trackLivePanes({
                tracked: [
                    tracked,
                ],
                live: [
                    {
                        folder: added.folder,
                        kind: added.kind,
                        sessionId: added.sessionId,
                    },
                ],
                nowMs,
            }),
            [
                {
                    ...tracked,
                    goneSinceMs: nowMs,
                },
                added,
            ],
        );
    });
});

describe(parseRecordedPanes.name, () => {
    it('keeps shell panes from a file that also lists a pane kind that no longer exists', () => {
        assert.deepEquals(
            parseRecordedPanes(
                JSON.stringify({
                    panes: [
                        {
                            folder: '/repo',
                            kind: 'ai',
                            sessionId: 'tab-1',
                            isWorking: true,
                        },
                        {
                            folder: '/repo',
                            kind: PaneKind.Shell,
                            sessionId: 'tab-2',
                            isWorking: false,
                        },
                    ],
                }),
            ),
            [
                {
                    folder: '/repo',
                    kind: PaneKind.Shell,
                    sessionId: 'tab-2',
                },
            ],
        );
    });
    it('reads a missing or broken file as no panes', () => {
        assert.deepEquals(parseRecordedPanes(''), []);
    });
});
