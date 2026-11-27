import {PaneKind} from '@agent-storm/common';
import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {createPaneRestarts, paneRestartKey} from './pane-restarts.js';

function createTestPaneRestarts() {
    const refreshes: Array<undefined> = [];
    const paneRestarts = createPaneRestarts({
        refresh() {
            refreshes.push(undefined);
            return Promise.resolve();
        },
    });
    return {
        paneRestarts,
        refreshes,
    };
}

describe(createPaneRestarts.name, () => {
    it('counts each pane separately', async () => {
        const {paneRestarts} = createTestPaneRestarts();
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Shell,
        });
        await paneRestarts.restart({
            folder: '/repos/other',
            kind: PaneKind.Shell,
        });
        await paneRestarts.restart({
            folder: '/repos/other',
            kind: PaneKind.Shell,
        });
        assert.deepEquals(paneRestarts.value, {
            keys: {
                [paneRestartKey({
                    folder: '/repos/solo',
                    kind: PaneKind.Shell,
                })]: 1,
                [paneRestartKey({
                    folder: '/repos/other',
                    kind: PaneKind.Shell,
                })]: 2,
            },
        });
    });
    it('polls the folder list after every restart', async () => {
        const {paneRestarts, refreshes} = createTestPaneRestarts();
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Shell,
        });
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Shell,
        });
        assert.isLengthExactly(refreshes, 2);
    });
});
