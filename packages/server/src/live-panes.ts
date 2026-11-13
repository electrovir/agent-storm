import {PaneKind, PaneStatus} from '@agent-storm/common';
import {awaitedForEach, extractErrorMessage, log, wrapInTry} from '@augment-vir/common';
import {writeFileAtomically} from 'agent-storm-util';
import {convertDuration, type AnyDuration} from 'date-vir';
import {readFile} from 'node:fs/promises';
import {defineShape, enumShape, parseJsonWithShape} from 'object-shape-tester';
import {livePanesPath} from './file-paths.js';
import {sendPaneText, spawnPane} from './pane-launch.js';
import {getAllPaneSessionStatuses} from './pty.js';
import {hasFolderSession} from './sessions.js';

const livePaneShape = defineShape({
    folder: '',
    kind: enumShape(PaneKind),
    sessionId: '',
    /** Only ever true for an AI pane in the middle of a task. */
    isWorking: false,
});

const livePanesShape = defineShape({
    panes: [livePaneShape],
});

export type LivePane = typeof livePaneShape.runtimeType;

type PaneId = Pick<LivePane, 'folder' | 'kind' | 'sessionId'>;

export type TrackedPane = PaneId & {
    /** When the pane was first seen gone. Undefined while it is running. */
    goneSinceMs: number | undefined;
    /** When the pane was last seen working. Undefined if it never was. */
    lastWorkingAtMs: number | undefined;
};

/** Typed into each restored AI pane that was working. */
const continuePrompt =
    'Agent Storm was shut down while you were working, likely by a reboot. Pick up where you left off.';

const isPaneStatusLive: Record<PaneStatus, boolean> = {
    [PaneStatus.None]: false,
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: true,
    [PaneStatus.Exited]: false,
};

const isPaneStatusWorking: Record<PaneStatus, boolean> = {
    [PaneStatus.None]: false,
    [PaneStatus.Busy]: true,
    [PaneStatus.Stalled]: true,
    [PaneStatus.Idle]: false,
    [PaneStatus.Exited]: false,
};

/** A busy shell is running a command, which can't be resumed by telling it to continue. */
const canPaneKindResumeWork: Record<PaneKind, boolean> = {
    [PaneKind.Ai]: true,
    [PaneKind.Shell]: false,
};

/**
 * How long a pane is still remembered as running, or as working, after it stops. A shutdown or
 * reboot interrupts the AIs and kills the panes moments before it kills this server, and forgetting
 * them in that gap would leave nothing to restore.
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

function matchesPane(pane: Readonly<PaneId>) {
    return (other: Readonly<PaneId>) => {
        return (
            other.folder === pane.folder &&
            other.kind === pane.kind &&
            other.sessionId === pane.sessionId
        );
    };
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
    const kept = tracked.flatMap((pane): TrackedPane[] => {
        const livePane = live.find(matchesPane(pane));
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
                lastWorkingAtMs: livePane?.isWorking ? nowMs : pane.lastWorkingAtMs,
            },
        ];
    });
    const added = live
        .filter((livePane) => !tracked.some(matchesPane(livePane)))
        .map((livePane): TrackedPane => {
            return {
                folder: livePane.folder,
                kind: livePane.kind,
                sessionId: livePane.sessionId,
                goneSinceMs: undefined,
                lastWorkingAtMs: livePane.isWorking ? nowMs : undefined,
            };
        });
    return [
        ...kept,
        ...added,
    ];
}

/** What gets saved: a pane counts as working until it has been done for the whole grace period. */
export function toRecordedPanes({
    tracked,
    nowMs,
}: Readonly<{
    tracked: ReadonlyArray<Readonly<TrackedPane>>;
    nowMs: number;
}>) {
    return tracked.map((pane): LivePane => {
        return {
            folder: pane.folder,
            kind: pane.kind,
            sessionId: pane.sessionId,
            isWorking:
                pane.lastWorkingAtMs != undefined &&
                isWithinGracePeriod({
                    sinceMs: pane.lastWorkingAtMs,
                    nowMs,
                }),
        };
    });
}

async function readRecordedPanes() {
    const contents = await readFile(livePanesPath, 'utf8').catch(() => '');
    return (
        wrapInTry(() => parseJsonWithShape(contents, livePanesShape), {
            fallbackValue: undefined,
        })?.panes || []
    );
}

async function fetchLivePanes() {
    return (await getAllPaneSessionStatuses())
        .filter((entry) => isPaneStatusLive[entry.status])
        .map((entry): LivePane => {
            return {
                folder: entry.folder,
                kind: entry.kind,
                sessionId: entry.sessionId,
                isWorking: canPaneKindResumeWork[entry.kind] && isPaneStatusWorking[entry.status],
            };
        });
}

/**
 * Starts each recorded pane that isn't running and whose tab still exists, and tells the AIs that
 * were working to continue. Working panes go first so their progress resumes soonest.
 */
async function restorePanes(panes: ReadonlyArray<Readonly<LivePane>>) {
    const live = await fetchLivePanes();
    const toRestore = panes
        .filter((pane) => !live.some(matchesPane(pane)))
        .toSorted((first, second) => Number(second.isWorking) - Number(first.isWorking));
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
            if (pane.isWorking) {
                await sendPaneText({
                    ...target,
                    text: continuePrompt,
                });
            } else {
                await spawnPane(target);
            }
        } catch (error) {
            log.warning(
                `Failed to restore ${pane.kind} tab in ${pane.folder}: ${extractErrorMessage(error)}`,
            );
        }
    });
}

/**
 * Restarts every pane that was running when this server last ran, such as before a reboot, and
 * tells the AIs that were mid-task to continue. Then keeps recording which panes are running so the
 * next start can do the same.
 */
export async function startLivePaneTracking() {
    const recorded = await readRecordedPanes();
    await restorePanes(recorded);
    const startMs = Date.now();
    const state: {
        tracked: TrackedPane[];
        written: string;
    } = {
        tracked: recorded.map((pane) => {
            return {
                folder: pane.folder,
                kind: pane.kind,
                sessionId: pane.sessionId,
                goneSinceMs: undefined,
                lastWorkingAtMs: pane.isWorking ? startMs : undefined,
            };
        }),
        written: '',
    };
    async function runPass() {
        /** An unreachable daemon says nothing about which panes are running, so the pass is skipped. */
        const live = await fetchLivePanes().catch(() => undefined);
        if (!live) {
            return;
        }
        const nowMs = Date.now();
        state.tracked = trackLivePanes({
            tracked: state.tracked,
            live,
            nowMs,
        });
        const serialized = JSON.stringify(
            {
                panes: toRecordedPanes({
                    tracked: state.tracked,
                    nowMs,
                }),
            } satisfies typeof livePanesShape.runtimeType,
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
                runPass()
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
    scheduleNextPass();
}
