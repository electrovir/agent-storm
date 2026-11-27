import {PaneKind, PaneStatus} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {
    awaitedForEach,
    extractErrorMessage,
    groupArrayBy,
    log,
    wait,
    wrapInTry,
    type Overwrite,
} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {convertDuration, type AnyDuration} from 'date-vir';
import {readFile} from 'node:fs/promises';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {livePanesPath} from './file-paths.js';
import {spawnPane} from './pane-launch.js';
import {getAllPaneSessionStatuses} from './pty.js';
import {hasFolderSession} from './sessions.js';

/**
 * `kind` is any string because a file saved by an earlier version can name a pane kind that no
 * longer exists, and one such pane failing the shape would drop every pane in the file.
 */
const recordedPanesShape = defineShape({
    panes: [
        {
            folder: '',
            kind: '',
            sessionId: '',
        },
    ],
});

export type LivePane = Overwrite<
    (typeof recordedPanesShape.runtimeType)['panes'][number],
    {
        kind: PaneKind;
    }
>;

type PaneId = Pick<LivePane, 'folder' | 'kind' | 'sessionId'>;

export type TrackedPane = PaneId & {
    /** When the pane was first seen gone. Undefined while it is running. */
    goneSinceMs: number | undefined;
};

const isPaneStatusLive: Record<PaneStatus, boolean> = {
    [PaneStatus.None]: false,
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: true,
    [PaneStatus.Exited]: false,
};

/**
 * How long a pane is still remembered as running after it stops. A shutdown or reboot kills the
 * panes moments before it kills this server, and forgetting them in that gap would leave nothing to
 * restore.
 */
const stoppedGracePeriod: AnyDuration = {
    seconds: 30,
};

function isWithinGracePeriod({sinceMs, nowMs}: Readonly<{sinceMs: number; nowMs: number}>) {
    return (
        nowMs - sinceMs <
        convertDuration(stoppedGracePeriod, {
            milliseconds: true,
        }).milliseconds
    );
}

function paneKey({folder, kind, sessionId}: Readonly<PaneId>) {
    return JSON.stringify([
        folder,
        kind,
        sessionId,
    ]);
}

/**
 * The next list of panes to restore: every running pane, plus each tracked pane that hasn't been
 * gone for the whole grace period.
 */
export function trackLivePanes({
    tracked,
    live,
    nowMs,
}: Readonly<{
    tracked: ReadonlyArray<Readonly<TrackedPane>>;
    live: ReadonlyArray<Readonly<LivePane>>;
    nowMs: number;
}>): TrackedPane[] {
    const livePanesByKey = groupArrayBy(live, paneKey);
    const trackedKeys = new Set(tracked.map(paneKey));
    const kept = tracked.flatMap((pane): TrackedPane[] => {
        const livePane = livePanesByKey[paneKey(pane)]?.[0];
        const goneSinceMs = livePane ? undefined : (pane.goneSinceMs ?? nowMs);
        if (
            goneSinceMs != undefined &&
            !isWithinGracePeriod({
                sinceMs: goneSinceMs,
                nowMs,
            })
        ) {
            return [];
        }
        return [
            {
                ...pane,
                goneSinceMs,
            },
        ];
    });
    const added = live
        .filter((livePane) => !trackedKeys.has(paneKey(livePane)))
        .map((livePane): TrackedPane => {
            return {
                folder: livePane.folder,
                kind: livePane.kind,
                sessionId: livePane.sessionId,
                goneSinceMs: undefined,
            };
        });
    return [
        ...kept,
        ...added,
    ];
}

/** What gets saved: every tracked pane, without its tracking state. */
export function toRecordedPanes(tracked: ReadonlyArray<Readonly<TrackedPane>>) {
    return tracked.map((pane): LivePane => {
        return {
            folder: pane.folder,
            kind: pane.kind,
            sessionId: pane.sessionId,
        };
    });
}

/** The panes a saved live panes file lists, skipping any whose kind no longer exists. */
export function parseRecordedPanes(contents: string) {
    const panes =
        wrapInTry(() => parseJsonWithShape(contents, recordedPanesShape), {
            fallbackValue: undefined,
        })?.panes || [];
    return panes.flatMap((pane): LivePane[] => {
        return check.isEnumValue(pane.kind, PaneKind)
            ? [
                  {
                      folder: pane.folder,
                      kind: pane.kind,
                      sessionId: pane.sessionId,
                  },
              ]
            : [];
    });
}

async function readRecordedPanes() {
    return parseRecordedPanes(await readFile(livePanesPath, 'utf8').catch(() => ''));
}

async function fetchLivePanes() {
    return (await getAllPaneSessionStatuses())
        .filter((entry) => isPaneStatusLive[entry.status])
        .map((entry): LivePane => {
            return {
                folder: entry.folder,
                kind: entry.kind,
                sessionId: entry.sessionId,
            };
        });
}

/** Starts each recorded pane that isn't running and whose tab still exists. */
async function restorePanes({
    panes,
    live,
}: Readonly<{
    panes: ReadonlyArray<Readonly<LivePane>>;
    live: ReadonlyArray<Readonly<LivePane>>;
}>) {
    const liveKeys = new Set(live.map(paneKey));
    const toRestore = panes.filter((pane) => !liveKeys.has(paneKey(pane)));
    await awaitedForEach(toRestore, async (pane) => {
        try {
            const target = {
                folder: pane.folder,
                kind: pane.kind,
                sessionId: pane.sessionId,
            };
            if (!(await hasFolderSession(target))) {
                return;
            }
            await spawnPane(target);
            /**
             * Each spawn returns before its shell finishes starting, so spawning a few hundred
             * panes back to back pegs every core until they all settle.
             */
            await wait({
                milliseconds: 500,
            });
        } catch (error) {
            log.warning(
                `Failed to restore ${pane.kind} tab in ${pane.folder}: ${extractErrorMessage(error)}`,
            );
        }
    });
}

/**
 * Restarts every pane that was running when this server last ran, such as before a reboot. Then
 * keeps recording which panes are running so the next start can do the same.
 */
export async function startLivePaneTracking() {
    const state: {
        tracked: TrackedPane[] | undefined;
        written: string;
    } = {
        tracked: undefined,
        written: '',
    };
    async function runPass(live: ReadonlyArray<Readonly<LivePane>>) {
        if (!state.tracked) {
            const recorded = await readRecordedPanes();
            await restorePanes({
                panes: recorded,
                live,
            });
            state.tracked = recorded.map((pane) => {
                return {
                    ...pane,
                    goneSinceMs: undefined,
                };
            });
            return;
        }
        state.tracked = trackLivePanes({
            tracked: state.tracked,
            live,
            nowMs: Date.now(),
        });
        const serialized = JSON.stringify(
            {
                panes: toRecordedPanes(state.tracked),
            } satisfies typeof recordedPanesShape.runtimeType,
            undefined,
            4,
        );
        if (serialized !== state.written) {
            await writeFileAtomically({
                path: livePanesPath,
                contents: serialized,
            });
            state.written = serialized;
        }
    }
    function scheduleNextPass() {
        setTimeout(
            () => {
                /**
                 * An unreachable daemon says nothing about which panes are running, so the pass is
                 * skipped.
                 */
                fetchLivePanes()
                    .then(runPass, () => undefined)
                    .catch((error: unknown) => {
                        log.warning(`Failed to record live tabs: ${extractErrorMessage(error)}`);
                    })
                    .finally(scheduleNextPass);
            },
            convertDuration(
                {
                    seconds: 5,
                },
                {
                    milliseconds: true,
                },
            ).milliseconds,
        );
    }
    try {
        await runPass(await fetchLivePanes());
    } finally {
        scheduleNextPass();
    }
}
