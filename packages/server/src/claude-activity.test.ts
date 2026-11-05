import {PaneStatus} from '@agent-storm/common';
import {assert, check} from '@augment-vir/assert';
import {awaitedBlockingMap} from '@augment-vir/common';
import {describe, it} from '@augment-vir/test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseCpuTime, resolveQuietClaudeStatus} from './claude-activity.js';
import {claudeHookSourceDir} from './file-paths.js';
import {runCommand} from './run-command.js';

const now = 10_000_000;

const quietTurn = {
    activity: {
        claudePid: 1234,
        turnActive: true,
        backgroundTaskCount: 0,
        updatedAt: now - 1000,
    },
    interruptedAt: 0,
    lastBusyAt: 0,
    sample: undefined,
    now,
};

describe(resolveQuietClaudeStatus.name, () => {
    it('keeps a quiet turn busy while hooks are still firing', () => {
        assert.strictEquals(resolveQuietClaudeStatus(quietTurn), PaneStatus.Busy);
    });

    it('marks open work stalled once nothing has shown life for a while', () => {
        assert.strictEquals(
            resolveQuietClaudeStatus({
                ...quietTurn,
                activity: {
                    ...quietTurn.activity,
                    updatedAt: now - 60 * 60 * 1000,
                },
                sample: {
                    isAlive: true,
                    cpuSeconds: 50,
                    sampledAt: now,
                    activeAt: now - 60 * 60 * 1000,
                },
            }),
            PaneStatus.Stalled,
        );
    });

    it('stays busy on background tasks after the turn ended while their CPU use continues', () => {
        assert.strictEquals(
            resolveQuietClaudeStatus({
                ...quietTurn,
                activity: {
                    ...quietTurn.activity,
                    turnActive: false,
                    backgroundTaskCount: 1,
                    updatedAt: now - 60 * 60 * 1000,
                },
                sample: {
                    isAlive: true,
                    cpuSeconds: 50,
                    sampledAt: now,
                    activeAt: now,
                },
            }),
            PaneStatus.Busy,
        );
    });

    it('treats an interrupted turn as over', () => {
        assert.strictEquals(
            resolveQuietClaudeStatus({
                ...quietTurn,
                interruptedAt: now - 500,
            }),
            PaneStatus.Idle,
        );
    });

    it('ignores state left behind by a Claude process that is gone', () => {
        assert.strictEquals(
            resolveQuietClaudeStatus({
                ...quietTurn,
                sample: {
                    isAlive: false,
                    cpuSeconds: 0,
                    sampledAt: now,
                    activeAt: 0,
                },
            }),
            PaneStatus.Idle,
        );
    });
});

describe(parseCpuTime.name, () => {
    it('reads minutes and hours', () => {
        assert.deepEquals(
            [
                parseCpuTime('31:10.25'),
                parseCpuTime('1:02:03.5'),
            ],
            [
                1870.25,
                3723.5,
            ],
        );
    });
});

describe('agent-storm-activity.sh', () => {
    it('marks a permission prompt until Claude moves on, keeping it through compaction', async () => {
        const home = await mkdtemp(join(tmpdir(), 'claude-activity-hook-'));
        try {
            const awaitingPermission = await awaitedBlockingMap(
                [
                    {
                        hook_event_name: 'UserPromptSubmit',
                    },
                    {
                        hook_event_name: 'Notification',
                        notification_type: 'permission_prompt',
                    },
                    {
                        hook_event_name: 'Notification',
                        notification_type: 'auth_success',
                    },
                    {
                        hook_event_name: 'SessionStart',
                        source: 'compact',
                    },
                    {
                        hook_event_name: 'PostToolUse',
                    },
                ],
                async (event) => {
                    await runCommand(
                        'bash',
                        [
                            '-c',
                            'bash "$0" <<<"$1"',
                            join(claudeHookSourceDir, 'agent-storm-activity.sh'),
                            JSON.stringify(event),
                        ],
                        {
                            env: {
                                ...process.env,
                                HOME: home,
                                AGENT_STORM_CONVERSATION_ID: 'abc',
                            },
                            timeout: {
                                seconds: 30,
                            },
                        },
                    );
                    const written: unknown = JSON.parse(
                        await readFile(
                            join(home, '.agent-storm', 'conversations', 'claude-activity', 'abc'),
                            'utf8',
                        ),
                    );
                    return check.isObject(written) && written.isAwaitingPermission;
                },
            );
            assert.deepEquals(awaitingPermission, [
                false,
                true,
                true,
                true,
                false,
            ]);
        } finally {
            await rm(home, {
                recursive: true,
                force: true,
            });
        }
    });
});
