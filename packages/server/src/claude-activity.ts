// cspell:words pids

import {PaneKind, PaneStatus} from '@agent-storm/common';
import {filterMap} from '@augment-vir/common';
import {convertDuration} from 'date-vir';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {checkValidShape, defineShape} from 'object-shape-tester';
import {collectDescendantPids} from './daemon/kill-process-tree.js';
import {type StatusEntry} from './daemon/protocol.js';
import {claudeActivityDir} from './file-paths.js';
import {findFolderSession} from './sessions.js';

const exec = promisify(execFile);

/** What `claude-hooks/agent-storm-activity.sh` writes for each conversation. */
const claudeActivityShape = defineShape({
    /** 0 when the hook couldn't find Claude among its ancestors. */
    claudePid: 0,
    turnActive: false,
    backgroundTaskCount: 0,
    updatedAt: 0,
});

type ClaudeActivity = typeof claudeActivityShape.runtimeType;

type ClaudeProcessSample = {
    isAlive: boolean;
    cpuSeconds: number;
    sampledAt: number;
    /** Last sample in which the process tree was using enough CPU to count as working. */
    activeAt: number;
};

/**
 * Share of one core above which Claude's process tree counts as working. Measured idle Claude
 * processes sit around 0.1–0.5% and one waiting on the model around 3%.
 */
const activeCpuFraction = 0.015;

const activityState: {
    interruptedAt: Map<string, number>;
    lastBusyAt: Map<string, number>;
    samples: Map<number, ClaudeProcessSample>;
    lastSampleAt: number;
} = {
    interruptedAt: new Map(),
    lastBusyAt: new Map(),
    samples: new Map(),
    lastSampleAt: 0,
};

/**
 * Note a key press that interrupts Claude's turn. Claude fires no hook when a turn is interrupted,
 * so without this the hook state would claim the turn is still running until it went stale.
 */
export function recordClaudeInterrupt(conversationId: string): void {
    activityState.interruptedAt.set(conversationId, Date.now());
}

/** CPU time as `ps` prints it, e.g. `31:10.24` or `1:02:03.45`, in seconds. */
export function parseCpuTime(time: string): number {
    return time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

async function readClaudeActivity(conversationId: string): Promise<ClaudeActivity | undefined> {
    try {
        const parsed: unknown = JSON.parse(
            await readFile(join(claudeActivityDir, conversationId), 'utf8'),
        );
        return checkValidShape(parsed, claudeActivityShape) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function hasOpenWork(activity: Readonly<ClaudeActivity>, interruptedAt: number): boolean {
    return (
        (activity.turnActive && activity.updatedAt > interruptedAt) ||
        activity.backgroundTaskCount > 0
    );
}

/**
 * Status for an AI pane whose terminal has gone quiet, given what Claude's hooks last reported.
 * Unfinished work (a turn or background tasks) reads as busy while anything still shows signs of
 * life, and as stalled once nothing has for a while: from outside, a hung task and a slow one look
 * the same, so a long silence is surfaced instead of guessed at.
 */
export function resolveQuietClaudeStatus({
    activity,
    interruptedAt,
    lastBusyAt,
    sample,
    now,
}: Readonly<{
    activity: Readonly<ClaudeActivity>;
    interruptedAt: number;
    lastBusyAt: number;
    sample: Readonly<ClaudeProcessSample> | undefined;
    now: number;
}>): PaneStatus {
    /** A dead Claude left this state behind; nothing it describes is still running. */
    if (sample?.isAlive === false || !hasOpenWork(activity, interruptedAt)) {
        return PaneStatus.Idle;
    }
    /** Not sampled yet counts as alive, like a first sample that has no rate to measure. */
    const cpuActiveAt = sample?.activeAt ?? (activity.claudePid > 0 ? now : 0);
    const lastSignOfLife = Math.max(activity.updatedAt, lastBusyAt, cpuActiveAt);
    return now - lastSignOfLife <
        convertDuration(
            {
                minutes: 3,
            },
            {
                milliseconds: true,
            },
        ).milliseconds
        ? PaneStatus.Busy
        : PaneStatus.Stalled;
}

/**
 * Sum the CPU time of each Claude process tree and note which ones are using enough of it to count
 * as working. One `ps` covers every pane, and runs at most every few seconds no matter how often
 * statuses are polled.
 */
async function sampleClaudeProcesses(claudeProcessIds: ReadonlyArray<number>): Promise<void> {
    const now = Date.now();
    if (
        !claudeProcessIds.length ||
        now - activityState.lastSampleAt <
            convertDuration(
                {
                    seconds: 5,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds
    ) {
        return;
    }
    activityState.lastSampleAt = now;
    const processTable = await exec('/bin/ps', [
        '-A',
        '-o',
        'pid=,ppid=,time=,comm=',
    ])
        .then(({stdout}) => stdout)
        .catch(() => undefined);
    if (!processTable) {
        return;
    }
    const rows = new Map(
        filterMap(
            processTable.split('\n'),
            (line) => {
                const [
                    pid,
                    ,
                    time,
                    ...command
                ] = line.trim().split(/\s+/);
                return {
                    pid: Number(pid),
                    cpuSeconds: parseCpuTime(time || ''),
                    command: command.join(' '),
                };
            },
            (row) => Number.isInteger(row.pid) && Number.isFinite(row.cpuSeconds),
        ).map((row) => {
            return [
                row.pid,
                row,
            ];
        }),
    );
    claudeProcessIds.forEach((claudePid) => {
        const command = rows.get(claudePid)?.command || '';
        /** Also catches the pid having been reused by something else since the hook recorded it. */
        if (command !== 'claude' && !command.endsWith('/claude')) {
            activityState.samples.set(claudePid, {
                isAlive: false,
                cpuSeconds: 0,
                sampledAt: now,
                activeAt: 0,
            });
            return;
        }
        const cpuSeconds = [
            claudePid,
            ...collectDescendantPids(processTable, claudePid),
        ].reduce((total, pid) => total + (rows.get(pid)?.cpuSeconds ?? 0), 0);
        const previous = activityState.samples.get(claudePid);
        /**
         * An old sample would average CPU use over minutes of idling. Without a recent one there is
         * no rate yet, which counts as a sign of life so a server restart can't flash every quiet
         * pane as stalled.
         */
        const recentPrevious =
            previous?.isAlive &&
            now - previous.sampledAt <
                convertDuration(
                    {
                        seconds: 30,
                    },
                    {
                        milliseconds: true,
                    },
                ).milliseconds
                ? previous
                : undefined;
        const isActive =
            !recentPrevious ||
            (cpuSeconds - recentPrevious.cpuSeconds) / ((now - recentPrevious.sampledAt) / 1000) >
                activeCpuFraction;
        activityState.samples.set(claudePid, {
            isAlive: true,
            cpuSeconds,
            sampledAt: now,
            activeAt: isActive ? now : recentPrevious.activeAt,
        });
    });
}

/**
 * Replace the output-based status of quiet AI panes with one informed by Claude's hooks, so a pane
 * stays busy through a long silent tool run or while background tasks finish after the turn ends.
 * Panes without hook state (other AIs, or a tab with no conversation id) keep the daemon's status.
 */
export async function applyClaudeActivity(
    entries: ReadonlyArray<Readonly<StatusEntry>>,
): Promise<StatusEntry[]> {
    const now = Date.now();
    const resolved = await Promise.all(
        entries.map(async (entry) => {
            const conversationId =
                entry.kind === PaneKind.Ai && entry.sessionId
                    ? (
                          await findFolderSession({
                              folder: entry.folder,
                              kind: entry.kind,
                              sessionId: entry.sessionId,
                          })
                      )?.conversationId
                    : undefined;
            if (conversationId && entry.status === PaneStatus.Busy) {
                activityState.lastBusyAt.set(conversationId, now);
            }
            const activity =
                conversationId && entry.status === PaneStatus.Idle
                    ? await readClaudeActivity(conversationId)
                    : undefined;
            return {
                entry,
                activity,
                interruptedAt:
                    (conversationId && activityState.interruptedAt.get(conversationId)) || 0,
                lastBusyAt: (conversationId && activityState.lastBusyAt.get(conversationId)) || 0,
            };
        }),
    );
    await sampleClaudeProcesses(
        filterMap(
            resolved,
            ({activity, interruptedAt}) => {
                return activity && hasOpenWork(activity, interruptedAt) ? activity.claudePid : 0;
            },
            (claudePid) => claudePid > 0,
        ),
    );
    return resolved.map(({entry, activity, interruptedAt, lastBusyAt}) => {
        return activity
            ? {
                  ...entry,
                  status: resolveQuietClaudeStatus({
                      activity,
                      interruptedAt,
                      lastBusyAt,
                      sample: activityState.samples.get(activity.claudePid),
                      now,
                  }),
              }
            : entry;
    });
}
