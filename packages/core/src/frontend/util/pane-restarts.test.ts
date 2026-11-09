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
    it('counts each pane separately and bumps the AI config only for AI panes', async () => {
        const {paneRestarts} = createTestPaneRestarts();
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Shell,
        });
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Ai,
        });
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Ai,
        });
        assert.deepEquals(paneRestarts.value, {
            keys: {
                [paneRestartKey({
                    folder: '/repos/solo',
                    kind: PaneKind.Shell,
                })]: 1,
                [paneRestartKey({
                    folder: '/repos/solo',
                    kind: PaneKind.Ai,
                })]: 2,
            },
            aiConfigRevision: 2,
        });
    });
    it('polls the folder list after every restart and AI config change', async () => {
        const {paneRestarts, refreshes} = createTestPaneRestarts();
        await paneRestarts.restart({
            folder: '/repos/solo',
            kind: PaneKind.Shell,
        });
        await paneRestarts.bumpAiConfig();
        assert.deepEquals(
            {
                aiConfigRevision: paneRestarts.value.aiConfigRevision,
                refreshCount: refreshes.length,
            },
            {
                aiConfigRevision: 1,
                refreshCount: 2,
            },
        );
    });
});
