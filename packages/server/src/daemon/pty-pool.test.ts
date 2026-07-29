import {PaneKind} from '@agent-storm/common';
import {assert, waitUntil} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    attachPane,
    killFolderPanes,
    killPaneSession,
    listAllPaneStatuses,
    restartPane,
} from './pty-pool.js';

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

describe('pane sessions', () => {
    it('keeps sessions of the same folder and kind on separate pty processes', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const firstOutput: string[] = [];
            const secondOutput: string[] = [];
            const first = attachPane({
                folder,
                kind: PaneKind.Ai,
                sessionId: 'session-one',
                aiCmd: persistentAiCommand('from-session-one'),
                onData(data) {
                    firstOutput.push(data);
                },
                onExit() {},
            });
            const second = attachPane({
                folder,
                kind: PaneKind.Ai,
                sessionId: 'session-two',
                aiCmd: persistentAiCommand('from-session-two'),
                onData(data) {
                    secondOutput.push(data);
                },
                onExit() {},
            });

            try {
                await waitUntil(
                    () =>
                        firstOutput.join('').includes('from-session-one') &&
                        secondOutput.join('').includes('from-session-two'),
                    {
                        interval: {
                            milliseconds: 20,
                        },
                        timeout: {
                            seconds: 5,
                        },
                    },
                );

                /**
                 * The point of the test: each session's output must stay in its own pty. A
                 * regression that collapses the session segment out of the pane key shows up here
                 * as both buffers containing both labels.
                 */
                assert.isFalse(firstOutput.join('').includes('from-session-two'));
                assert.isFalse(secondOutput.join('').includes('from-session-one'));
            } finally {
                first.detach();
                second.detach();
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

    it('kills one session without disturbing its siblings', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const survivorExits: Array<number | undefined> = [];
            const doomed = attachPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'doomed',
                onData() {},
                onExit() {},
            });
            const survivor = attachPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'survivor',
                onData() {},
                onExit(exitCode) {
                    survivorExits.push(exitCode);
                },
            });

            try {
                killPaneSession({
                    folder,
                    kind: PaneKind.Shell,
                    sessionId: 'doomed',
                });

                await waitUntil(
                    () =>
                        !listAllPaneStatuses().some(
                            (entry) => entry.folder === folder && entry.sessionId === 'doomed',
                        ),
                    {
                        interval: {
                            milliseconds: 20,
                        },
                        timeout: {
                            seconds: 3,
                        },
                    },
                );

                assert.isLengthExactly(
                    listAllPaneStatuses().filter(
                        (entry) => entry.folder === folder && entry.sessionId === 'survivor',
                    ),
                    1,
                );
                assert.deepEquals(survivorExits, []);
            } finally {
                doomed.detach();
                survivor.detach();
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

    it('does not kill a sibling folder whose path shares a prefix', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        const target = join(parent, 'repo');
        const lookalike = join(parent, 'repo-two');
        try {
            await mkdir(target);
            await mkdir(lookalike);
            const targetPane = attachPane({
                folder: target,
                kind: PaneKind.Shell,
                onData() {},
                onExit() {},
            });
            const lookalikePane = attachPane({
                folder: lookalike,
                kind: PaneKind.Shell,
                onData() {},
                onExit() {},
            });

            try {
                killFolderPanes({
                    folder: target,
                });

                /**
                 * A `startsWith` folder match would take `repo-two` down along with `repo`, which
                 * is why entries are matched on their stored `folder` field instead.
                 */
                assert.isLengthExactly(
                    listAllPaneStatuses().filter((entry) => entry.folder === lookalike),
                    1,
                );
                assert.isLengthExactly(
                    listAllPaneStatuses().filter((entry) => entry.folder === target),
                    0,
                );
            } finally {
                targetPane.detach();
                lookalikePane.detach();
                killFolderPanes({
                    folder: lookalike,
                });
            }
        } finally {
            await rm(parent, {
                recursive: true,
                force: true,
            });
        }
    });
});
