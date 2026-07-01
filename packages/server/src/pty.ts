import {PaneStatus, type PaneKind} from '@agent-storm/common';
import {fetchPaneStatuses} from './daemon/daemon-client.js';

/**
 * Short cache so a `/folders` aggregation doesn't fan out to one daemon round-trip per pane,
 * but short enough that the sidebar (which polls every ~500ms) doesn't perceive stale status.
 */
const cacheTtlMs = 200;

let cachedStatuses = new Map<string, PaneStatus>();
let lastFetchAt = 0;

function statusKey(folder: string, kind: PaneKind): string {
    return `${folder}:${kind}`;
}

async function refreshStatuses(): Promise<void> {
    const entries = await fetchPaneStatuses();
    cachedStatuses = new Map(
        entries.map(
            (entry) =>
                [
                    statusKey(entry.folder, entry.kind),
                    entry.status,
                ] as const,
        ),
    );
    lastFetchAt = Date.now();
}

/**
 * Returns a lookup over a recent pane status snapshot. The daemon is queried at most every 500ms so
 * a single `/folders` aggregation doesn't trigger one round-trip per pane.
 */
export async function getPaneStatusLookup(): Promise<
    (folder: string, kind: PaneKind) => PaneStatus
> {
    if (Date.now() - lastFetchAt > cacheTtlMs) {
        await refreshStatuses();
    }
    return (folder, kind) => cachedStatuses.get(statusKey(folder, kind)) || PaneStatus.None;
}
