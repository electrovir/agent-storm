import {PaneKind} from '@agent-storm/common';
import {assert, waitUntil} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {describe, it} from '@augment-vir/test';
import {type AnyDuration} from 'date-vir';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    attachPane,
    killFolderPanes,
    killPaneSession,
    listAllPaneStatuses,
    livePtyCount,
    restartPane,
    writeToPane,
} from './pty-pool.js';

type PaneTestCommands = {
    printLine: (text: string) => string;
    waitForever: string;
};

const unixPaneTestCommands: PaneTestCommands = {
    printLine(text) {
        const escapedText = text.replaceAll('\x1b', String.raw`\033`);
        return String.raw`printf '%b\n' '${escapedText}'`;
    },
    waitForever: 'while true; do sleep 1; done',
};

/** Pane commands in the shell each OS's panes run in. */
const paneTestCommands = (
    {
        [OperatingSystem.Mac]: unixPaneTestCommands,
        [OperatingSystem.Linux]: unixPaneTestCommands,
        [OperatingSystem.Windows]: {
            printLine(text) {
                return `Write-Output "${text.replaceAll('\x1b', '$([char]27)')}"`;
            },
            waitForever: 'while ($true) { Start-Sleep 1 }',
        },
    } satisfies Record<OperatingSystem, PaneTestCommands>
)[currentOperatingSystem];

/**
 * Node-pty on Windows reports the terminal's name as every pane's process, so a pane's foreground
 * command can't be detected there.
 */
const itWithForegroundProcess = (
    {
        [OperatingSystem.Mac]: it,
        [OperatingSystem.Linux]: it,
        [OperatingSystem.Windows]: it.skip,
    } satisfies Record<OperatingSystem, typeof it.skip>
)[currentOperatingSystem];

/**
 * Each pane starts the user's interactive login shell, which can take seconds while the other
 * packages' tests load every core.
 */
const paneOutputTimeout: AnyDuration = {
    seconds: 15,
};

function persistentCommand(label: string): string {
    return [
        paneTestCommands.printLine(label),
        paneTestCommands.waitForever,
    ].join('; ');
}

/** The typed command is echoed back, so only a line made of the label alone is the command's output. */
function hasOutputLine(output: ReadonlyArray<string>, label: string): boolean {
    return output.join('').split(/\r?\n/).includes(label);
}

describe(restartPane.name, () => {
    it('keeps existing subscribers attached to the restarted pane', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const exits: Array<number | undefined> = [];
            const attachment = attachPane({
                folder,
                kind: PaneKind.Shell,
                onData(data) {
                    output.push(data);
                },
                onExit(exitCode) {
                    exits.push(exitCode);
                },
            });
            writeToPane({
                folder,
                kind: PaneKind.Shell,
                data: `${persistentCommand('before-restart')}\n`,
            });

            try {
                await waitUntil(() => hasOutputLine(output, 'before-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });

                restartPane({
                    folder,
                    kind: PaneKind.Shell,
                });

                writeToPane({
                    folder,
                    kind: PaneKind.Shell,
                    data: `${persistentCommand('after-restart')}\n`,
                });

                await waitUntil(() => hasOutputLine(output, 'after-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
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
                kind: PaneKind.Shell,
                onData(data) {
                    output.push(data);
                },
                onExit(exitCode) {
                    exits.push(exitCode);
                },
            });
            writeToPane({
                folder,
                kind: PaneKind.Shell,
                data: `${paneTestCommands.printLine('before-exit')}; exit 0\n`,
            });

            try {
                await waitUntil(() => hasOutputLine(output, 'before-exit'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });
                await waitUntil(() => exits.includes(0), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });

                restartPane({
                    folder,
                    kind: PaneKind.Shell,
                });

                writeToPane({
                    folder,
                    kind: PaneKind.Shell,
                    data: `${persistentCommand('after-exit-restart')}\n`,
                });

                await waitUntil(() => hasOutputLine(output, 'after-exit-restart'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
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
                kind: PaneKind.Shell,
                sessionId: 'session-one',
                onData(data) {
                    firstOutput.push(data);
                },
                onExit() {},
            });
            const second = attachPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'session-two',
                onData(data) {
                    secondOutput.push(data);
                },
                onExit() {},
            });

            writeToPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'session-one',
                data: `${persistentCommand('from-session-one')}\n`,
            });
            writeToPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'session-two',
                data: `${persistentCommand('from-session-two')}\n`,
            });

            try {
                await waitUntil(
                    () => {
                        return (
                            hasOutputLine(firstOutput, 'from-session-one') &&
                            hasOutputLine(secondOutput, 'from-session-two')
                        );
                    },
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
                    () => {
                        return !listAllPaneStatuses().some(
                            (entry) => entry.folder === folder && entry.sessionId === 'doomed',
                        );
                    },
                    {
                        interval: {
                            milliseconds: 20,
                        },
                        timeout: paneOutputTimeout,
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

describe(attachPane.name, () => {
    it('drops device attributes queries from the replayed scrollback', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const first = attachPane({
                folder,
                kind: PaneKind.Shell,
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });
            writeToPane({
                folder,
                kind: PaneKind.Shell,
                data: `${paneTestCommands.printLine('start\x1b[c\x1b[>0c end')}\n`,
            });
            try {
                await waitUntil(() => output.join('').includes('start\x1b[c\x1b[>0c end'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });
                const second = attachPane({
                    folder,
                    kind: PaneKind.Shell,
                    onData() {},
                    onExit() {},
                });
                second.detach();

                assert.isTrue(output.join('').includes('start\x1b[c\x1b[>0c end'));
                assert.isTrue(second.scrollback.includes('start end'));
            } finally {
                first.detach();
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

describe(livePtyCount.name, () => {
    it('holds no extra pty after a restart and a kill', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        const before = livePtyCount();
        try {
            const output: string[] = [];
            const attachment = attachPane({
                folder,
                kind: PaneKind.Shell,
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });
            writeToPane({
                folder,
                kind: PaneKind.Shell,
                data: `${persistentCommand('counted')}\n`,
            });

            try {
                await waitUntil(() => hasOutputLine(output, 'counted'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });

                restartPane({
                    folder,
                    kind: PaneKind.Shell,
                });

                writeToPane({
                    folder,
                    kind: PaneKind.Shell,
                    data: `${persistentCommand('counted-again')}\n`,
                });
                await waitUntil(() => hasOutputLine(output, 'counted-again'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });

                /** The superseded pty is released, not stranded, so a restart is net zero. */
                assert.strictEquals(livePtyCount(), before + 1);
            } finally {
                attachment.detach();
                killFolderPanes({
                    folder,
                });
            }

            assert.strictEquals(livePtyCount(), before);
        } finally {
            await rm(folder, {
                recursive: true,
                force: true,
            });
        }
    });
});

describe(listAllPaneStatuses.name, () => {
    itWithForegroundProcess('reports a running command only for the pane running it', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const busyAttachment = attachPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'busy',
                onData() {},
                onExit() {},
            });
            const quietAttachment = attachPane({
                folder,
                kind: PaneKind.Shell,
                sessionId: 'quiet',
                onData() {},
                onExit() {},
            });
            try {
                writeToPane({
                    folder,
                    kind: PaneKind.Shell,
                    sessionId: 'busy',
                    data: 'sleep 30\n',
                });
                const expectedStates = [
                    {
                        sessionId: 'busy',
                        isRunningCommand: true,
                    },
                    {
                        sessionId: 'quiet',
                        isRunningCommand: false,
                    },
                ];
                function listPaneStates() {
                    return listAllPaneStatuses()
                        .filter((status) => status.folder === folder)
                        .map((status) => {
                            return {
                                sessionId: status.sessionId,
                                isRunningCommand: status.isRunningCommand,
                            };
                        })
                        .toSorted((first, second) => {
                            return (first.sessionId || '').localeCompare(second.sessionId || '');
                        });
                }
                await waitUntil.isTrue(
                    () => JSON.stringify(listPaneStates()) === JSON.stringify(expectedStates),
                    {
                        interval: {
                            milliseconds: 50,
                        },
                        timeout: {
                            seconds: 10,
                        },
                    },
                );

                assert.deepEquals(listPaneStates(), expectedStates);
            } finally {
                busyAttachment.detach();
                quietAttachment.detach();
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
