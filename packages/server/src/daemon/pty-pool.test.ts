import {PaneKind} from '@agent-storm/common';
import {assert, waitUntil} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachPane, killFolderPanes, restartPane} from './pty-pool.js';

function persistentAiCommand(label: string): string {
    return String.raw`printf '${label}\n'; while true; do sleep 1; done`;
}

describe(restartPane.name, () => {
    it('keeps existing subscribers attached to the restarted pane', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const exits: Array<number | undefined> = [];
            const attachment = attachPane({
                folder,
                kind: PaneKind.Ai,
                aiCmd: persistentAiCommand('before-restart'),
                onData(data) {
                    output.push(data);
                },
                onExit(exitCode) {
                    exits.push(exitCode);
                },
            });

            try {
                await waitUntil(() => output.join('').includes('before-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });

                restartPane({
                    folder,
                    kind: PaneKind.Ai,
                    aiCmd: persistentAiCommand('after-restart'),
                });

                await waitUntil(() => output.join('').includes('after-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });
                await wait({
                    milliseconds: 200,
                });

                assert.deepEquals(exits, []);
            } finally {
                attachment.detach();
                killFolderPanes({
                    folder,
                });
            }
        } finally {
            await rm(folder, {
                recursive: true,
                force: true,
            });
        }
    });

    it('restarts an exited pane for existing subscribers', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const exits: Array<number | undefined> = [];
            const attachment = attachPane({
                folder,
                kind: PaneKind.Ai,
                aiCmd: String.raw`printf 'before-exit\n'`,
                onData(data) {
                    output.push(data);
                },
                onExit(exitCode) {
                    exits.push(exitCode);
                },
            });

            try {
                await waitUntil(() => output.join('').includes('before-exit'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });
                await waitUntil(() => exits.includes(0), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });

                restartPane({
                    folder,
                    kind: PaneKind.Ai,
                    aiCmd: persistentAiCommand('after-exit-restart'),
                });

                await waitUntil(() => output.join('').includes('after-exit-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });
            } finally {
                attachment.detach();
                killFolderPanes({
                    folder,
                });
            }
        } finally {
            await rm(folder, {
                recursive: true,
                force: true,
            });
        }
    });
});
