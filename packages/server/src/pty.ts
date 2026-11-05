import {PaneStatus, type PaneKind, type PaneSessionStatus} from '@agent-storm/common';
import {groupArrayBy, mapObjectValues} from '@augment-vir/common';
import {convertDuration, type AnyDuration} from 'date-vir';
import {applyClaudeActivity} from './claude-activity.js';
import {fetchPaneStatuses} from './daemon/daemon-client.js';
import {type StatusEntry} from './daemon/protocol.js';

const cacheTtl: AnyDuration = {
    milliseconds: 500,
};

const cacheState: {
    statuses: Partial<Record<string, PaneStatus>>;
    sessionIds: Partial<Record<string, string[]>>;
    sessionStatuses: Partial<Record<string, PaneSessionStatus[]>>;
    lastFetchAt: number;
    /** Bumped by {@link invalidatePaneStatuses} so a fetch already in flight can't save stale data. */
    generation: number;
} = {
    statuses: {},
    sessionIds: {},
    sessionStatuses: {},
    lastFetchAt: 0,
    generation: 0,
};

function statusKey(folder: string, kind: PaneKind): string {
    return `${folder}:${kind}`;
}

/**
 * Precedence used to collapse a folder+kind's sessions into the single status the sidebar renders.
 * A folder with any busy session reads as busy; failing that, a stalled one reads as stalled, and
 * any live-but-quiet session reads as idle; `Exited` only surfaces when every session has exited,
 * and `None` when there are no sessions at all. Lower number wins.
 */
const statusPriority: Record<PaneStatus, number> = {
    [PaneStatus.Busy]: 0,
    [PaneStatus.Stalled]: 1,
    [PaneStatus.Idle]: 2,
    [PaneStatus.Exited]: 3,
    [PaneStatus.None]: 4,
};

function reduceStatuses(entries: ReadonlyArray<Readonly<StatusEntry>>) {
    return mapObjectValues(
        groupArrayBy(entries, (entry) => statusKey(entry.folder, entry.kind), {
            useRequired: true,
        }),
        (_key, group) => {
            return group.reduce((winner: PaneStatus, entry) => {
                return statusPriority[entry.status] < statusPriority[winner]
                    ? entry.status
                    : winner;
            }, PaneStatus.None);
        },
    );
}

/**
 * Entries without a `sessionId` (a version-1 daemon) are dropped rather than guessed at: the
 * reduced per-folder+kind status above still covers them, and inventing a session id would attach
 * the status to a tab that may not exist.
 */
function filterSessionEntries(entries: ReadonlyArray<Readonly<StatusEntry>>) {
    return entries.filter((entry): entry is Readonly<StatusEntry & {sessionId: string}> => {
        return !!entry.sessionId;
    });
}

function collectSessionIds(entries: ReadonlyArray<Readonly<StatusEntry>>) {
    return mapObjectValues(
        groupArrayBy(
            filterSessionEntries(entries),
            (entry) => statusKey(entry.folder, entry.kind),
            {
                useRequired: true,
            },
        ),
        (_key, group) => group.map((entry) => entry.sessionId),
    );
}

/** Group the raw entries by folder, keeping each session's own status. */
function collectSessionStatuses(entries: ReadonlyArray<Readonly<StatusEntry>>) {
    return mapObjectValues(
        groupArrayBy(filterSessionEntries(entries), (entry) => entry.folder, {
            useRequired: true,
        }),
        (_key, group) => {
            return group.map((entry): PaneSessionStatus => {
                return {
                    kind: entry.kind,
                    sessionId: entry.sessionId,
                    status: entry.status,
                };
            });
        },
    );
}

/** Recursive, so its return type can't be inferred. */
async function refreshStatuses(): Promise<void> {
    const generation = cacheState.generation;
    const entries = await applyClaudeActivity(await fetchPaneStatuses());
    if (generation !== cacheState.generation) {
        return refreshStatuses();
    }
    cacheState.statuses = reduceStatuses(entries);
    cacheState.sessionIds = collectSessionIds(entries);
    cacheState.sessionStatuses = collectSessionStatuses(entries);
    cacheState.lastFetchAt = Date.now();
}

async function ensureFresh(): Promise<void> {
    if (
        Date.now() - cacheState.lastFetchAt >
        convertDuration(cacheTtl, {
            milliseconds: true,
        }).milliseconds
    ) {
        await refreshStatuses();
    }
}

/**
 * Forces the next read to query the daemon. Call after killing a session: a snapshot taken before
 * the kill still lists it as live, and the session-list reconcile would re-add its tab.
 */
export function invalidatePaneStatuses(): void {
    cacheState.lastFetchAt = 0;
    cacheState.generation++;
}

/**
 * Returns a lookup over a recent pane status snapshot. The daemon is queried at most once per
 * {@link cacheTtl} so a single `/folders` aggregation doesn't trigger one round-trip per pane.
 * Multiple sessions under the same folder+kind are reduced to one status via
 * {@link statusPriority}.
 */
export async function getPaneStatusLookup(): Promise<
    (folder: string, kind: PaneKind) => PaneStatus
> {
    await ensureFresh();
    return (folder, kind) => cacheState.statuses[statusKey(folder, kind)] || PaneStatus.None;
}

/**
 * Companion to {@link getPaneStatusLookup} that keeps each session's own status instead of reducing
 * them, so a pane's tabs can be annotated individually. Shares the same snapshot.
 */
export async function getPaneSessionStatusLookup(): Promise<
    (folder: string) => ReadonlyArray<PaneSessionStatus>
> {
    await ensureFresh();
    return (folder) => cacheState.sessionStatuses[folder] || [];
}

/**
 * Session ids the daemon currently holds a PTY for, per folder+kind. Used to reconcile the
 * persisted session list against reality so a live PTY always has a tab pointing at it.
 */
export async function getLivePaneSessionIds(
    folder: string,
    kind: PaneKind,
): Promise<ReadonlyArray<string>> {
    await ensureFresh();
    return cacheState.sessionIds[statusKey(folder, kind)] || [];
}
