import {PaneStatus, type PaneKind} from '@agent-storm/common';
import {fetchPaneStatuses} from './daemon/daemon-client.js';
import {type StatusEntry} from './daemon/protocol.js';

const cacheTtlMs = 500;

const cacheState: {
    statuses: Map<string, PaneStatus>;
    sessionIds: Map<string, string[]>;
    lastFetchAt: number;
} = {
    statuses: new Map(),
    sessionIds: new Map(),
    lastFetchAt: 0,
};

function statusKey(folder: string, kind: PaneKind): string {
    return `${folder}:${kind}`;
}

/**
 * Precedence used to collapse a folder+kind's sessions into the single status the sidebar renders.
 * A folder with any busy session reads as busy; failing that, any live-but-quiet session reads as
 * idle; `Exited` only surfaces when every session has exited, and `None` when there are no sessions
 * at all. Lower number wins.
 */
const statusPriority: Record<PaneStatus, number> = {
    [PaneStatus.Busy]: 0,
    [PaneStatus.Idle]: 1,
    [PaneStatus.Exited]: 2,
    [PaneStatus.None]: 3,
};

function reduceStatuses(entries: ReadonlyArray<Readonly<StatusEntry>>): Map<string, PaneStatus> {
    return entries.reduce((reduced, entry) => {
        const key = statusKey(entry.folder, entry.kind);
        const existing = reduced.get(key);
        if (existing == undefined || statusPriority[entry.status] < statusPriority[existing]) {
            reduced.set(key, entry.status);
        }
        return reduced;
    }, new Map<string, PaneStatus>());
}

function collectSessionIds(entries: ReadonlyArray<Readonly<StatusEntry>>): Map<string, string[]> {
    return entries.reduce((collected, entry) => {
        if (!entry.sessionId) {
            return collected;
        }
        const key = statusKey(entry.folder, entry.kind);
        const existing = collected.get(key);
        if (existing) {
            existing.push(entry.sessionId);
        } else {
            collected.set(key, [entry.sessionId]);
        }
        return collected;
    }, new Map<string, string[]>());
}

async function refreshStatuses(): Promise<void> {
    const entries = await fetchPaneStatuses();
    cacheState.statuses = reduceStatuses(entries);
    cacheState.sessionIds = collectSessionIds(entries);
    cacheState.lastFetchAt = Date.now();
}

async function ensureFresh(): Promise<void> {
    if (Date.now() - cacheState.lastFetchAt > cacheTtlMs) {
        await refreshStatuses();
    }
}

/**
 * Returns a lookup over a recent pane status snapshot. The daemon is queried at most every 500ms so
 * a single `/folders` aggregation doesn't trigger one round-trip per pane. Multiple sessions under
 * the same folder+kind are reduced to one status via {@link statusPriority}.
 */
export async function getPaneStatusLookup(): Promise<
    (folder: string, kind: PaneKind) => PaneStatus
> {
    await ensureFresh();
    return (folder, kind) => cacheState.statuses.get(statusKey(folder, kind)) || PaneStatus.None;
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
    return cacheState.sessionIds.get(statusKey(folder, kind)) || [];
}
