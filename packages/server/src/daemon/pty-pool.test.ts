import {PaneKind} from '@agent-storm/common';
import {assert, waitUntil} from '@augment-vir/assert';
import {wait} from '@augment-vir/common';
import {currentOperatingSystem, OperatingSystem} from '@augment-vir/node';
import {describe, it} from '@augment-vir/test';
import {type AnyDuration} from 'date-vir';
import {createHmac} from 'node:crypto';
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
    verifyLaunchSignature,
    writeToPane,
} from './pty-pool.js';

type PaneTestCommands = {
    printLine: (text: string) => string;
    printEnvLine: (params: Readonly<{prefix: string; envKey: string}>) => string;
    waitForever: string;
};

const unixPaneTestCommands: PaneTestCommands = {
    printLine(text) {
        return String.raw`printf '%s\n' '${text}'`;
    },
    printEnvLine({prefix, envKey}) {
        return String.raw`printf '${prefix}%s\n' "$${envKey}"`;
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
            printEnvLine({prefix, envKey}) {
                return `Write-Output "${prefix}$env:${envKey}"`;
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

function persistentAiCommand(label: string): string {
    return [
        paneTestCommands.printLine(label),
        paneTestCommands.waitForever,
    ].join('; ');
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
                    timeout: paneOutputTimeout,
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
                kind: PaneKind.Ai,
                aiCmd: paneTestCommands.printLine('before-exit'),
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
                    kind: PaneKind.Ai,
                    aiCmd: persistentAiCommand('after-exit-restart'),
                });

                await waitUntil(() => output.join('').includes('after-exit-restart'), {
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
                    () => {
                        return (
                            firstOutput.join('').includes('from-session-one') &&
                            secondOutput.join('').includes('from-session-two')
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
    it('replays mode settings that scrollback trimming dropped', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const first = attachPane({
                folder,
                kind: PaneKind.Ai,
                aiCmd: String.raw`printf '\033[?25l\033[?2004h\033[?1004h\033[?20'; printf '04l\033[?1049h'; seq 1 50; printf 'done\n'; while true; do sleep 1; done`,
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });
            try {
                await waitUntil(() => output.join('').includes('done'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 3,
                    },
                });
                const second = attachPane({
                    folder,
                    kind: PaneKind.Ai,
                    scrollbackLimit: 5,
                    onData() {},
                    onExit() {},
                });
                second.detach();

                assert.isTrue(second.scrollback.startsWith('\x1b[?25l\x1b[?2004l\x1b[?1004h'));
                assert.isFalse(second.scrollback.includes('\x1b[?1049h'));
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

    it('drops device attributes queries from the replayed scrollback', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const first = attachPane({
                folder,
                kind: PaneKind.Ai,
                aiCmd: [
                    paneTestCommands.printLine('start\x1b[c\x1b[>0c end'),
                    paneTestCommands.waitForever,
                ].join('; '),
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });
            try {
                await waitUntil(() => output.join('').includes(' end'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });
                const second = attachPane({
                    folder,
                    kind: PaneKind.Ai,
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
                kind: PaneKind.Ai,
                aiCmd: persistentAiCommand('counted'),
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });

            try {
                await waitUntil(() => output.join('').includes('counted'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: paneOutputTimeout,
                });

                restartPane({
                    folder,
                    kind: PaneKind.Ai,
                    aiCmd: persistentAiCommand('counted-again'),
                });
                await waitUntil(() => output.join('').includes('counted-again'), {
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

describe(verifyLaunchSignature.name, () => {
    it('accepts only signatures from the running tab key', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const output: string[] = [];
            const attachment = attachPane({
                folder,
                kind: PaneKind.Ai,
                conversationId: 'launch-conversation',
                aiCmd: [
                    paneTestCommands.printEnvLine({
                        prefix: 'key=',
                        envKey: 'AGENT_STORM_LAUNCH_KEY',
                    }),
                    paneTestCommands.waitForever,
                ].join('; '),
                onData(data) {
                    output.push(data);
                },
                onExit() {},
            });
            try {
                const launchKey = await waitUntil.isString(
                    () => {
                        return /key=([0-9a-f]{64})/.exec(output.join(''))?.[1];
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
                const payload = '{"folder":"/example"}';
                const signature = createHmac('sha256', launchKey).update(payload).digest('hex');

                assert.deepEquals(
                    [
                        verifyLaunchSignature({
                            conversationId: 'launch-conversation',
                            payload,
                            signature,
                        }),
                        verifyLaunchSignature({
                            conversationId: 'launch-conversation',
                            payload: '{"folder":"/elsewhere"}',
                            signature,
                        }),
                        verifyLaunchSignature({
                            conversationId: 'other-conversation',
                            payload,
                            signature,
                        }),
                    ],
                    [
                        true,
                        false,
                        false,
                    ],
                );

                attachment.detach();
                killFolderPanes({
                    folder,
                });
                assert.isFalse(
                    verifyLaunchSignature({
                        conversationId: 'launch-conversation',
                        payload,
                        signature,
                    }),
                );
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

describe(listAllPaneStatuses.name, () => {
    itWithForegroundProcess('reports a running command only for a shell pane', async () => {
        const folder = await mkdtemp(join(tmpdir(), 'agent-storm-pty-pool-'));
        try {
            const aiOutput: string[] = [];
            const aiAttachment = attachPane({
                folder,
                kind: PaneKind.Ai,
                aiCmd: String.raw`printf 'ai-ready\n'; sleep 30`,
                onData(data) {
                    aiOutput.push(data);
                },
                onExit() {},
            });
            const shellAttachment = attachPane({
                folder,
                kind: PaneKind.Shell,
                onData() {},
                onExit() {},
            });
            try {
                await waitUntil.isTrue(() => aiOutput.join('').includes('ai-ready'), {
                    interval: {
                        milliseconds: 20,
                    },
                    timeout: {
                        seconds: 5,
                    },
                });
                writeToPane({
                    folder,
                    kind: PaneKind.Shell,
                    data: 'sleep 30\n',
                });
                await waitUntil.isTrue(
                    () => {
                        return listAllPaneStatuses().some((status) => {
                            return (
                                status.folder === folder &&
                                status.kind === PaneKind.Shell &&
                                status.isRunningCommand
                            );
                        });
                    },
                    {
                        interval: {
                            milliseconds: 50,
                        },
                        timeout: {
                            seconds: 10,
                        },
                    },
                );

                assert.deepEquals(
                    listAllPaneStatuses()
                        .filter((status) => status.folder === folder)
                        .map((status) => {
                            return {
                                kind: status.kind,
                                isRunningCommand: status.isRunningCommand,
                            };
                        })
                        .toSorted((first, second) => first.kind.localeCompare(second.kind)),
                    [
                        {
                            kind: PaneKind.Ai,
                            isRunningCommand: false,
                        },
                        {
                            kind: PaneKind.Shell,
                            isRunningCommand: true,
                        },
                    ],
                );
            } finally {
                aiAttachment.detach();
                shellAttachment.detach();
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
