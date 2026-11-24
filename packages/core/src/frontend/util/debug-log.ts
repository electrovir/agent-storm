import {clientDebugLogEndpoint} from '@agent-storm/common';
import {createArray, randomString, wrapInTry} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString, type AnyDuration} from 'date-vir';
import {checkValidShape, defineShape} from 'object-shape-tester';
import {fetchApi} from './api-client.js';

const windowId = randomString(8);

/** Mutated in place: entries collect here between sends. */
const pending: {
    entries: Array<{
        at: string;
        event: string;
        details: unknown;
    }>;
    isSendScheduled: boolean;
    /** Follows the `enableDebugLogs` setting. */
    isEnabled: boolean;
} = {
    entries: [],
    isSendScheduled: false,
    isEnabled: false,
};

const freezeTrailKeyPrefix = 'agent-storm-freeze-trail:';
const ownFreezeTrailKey = `${freezeTrailKeyPrefix}${windowId}`;
/** Newest entries kept in a window's freeze trail. */
const freezeTrailEntryCount = 80;
/** A visible window whose trail has gone unrefreshed this long is frozen or was killed. */
const freezeTrailStaleness = {
    milliseconds: 10_000,
} as const satisfies AnyDuration;

const freezeTrailShape = defineShape({
    /** When the window last proved its main thread was running. */
    aliveAt: 0,
    isVisible: false,
    entries: [
        {
            at: 0,
            event: '',
        },
    ],
});

/**
 * Mutated in place: entries are added on every render and animation frame while debug logs are on,
 * so copying the trail each time would cost more than the trail is worth.
 */
const freezeTrail: {
    hasStarted: boolean;
    trail: typeof freezeTrailShape.runtimeType;
    /** Other windows' trails this page already reported. */
    reportedKeys: string[];
} = {
    hasStarted: false,
    trail: {
        aliveAt: Date.now(),
        isVisible: false,
        entries: [],
    },
    reportedKeys: [],
};

/**
 * `localStorage` rather than a request because a frozen WebKit page sends nothing, not even from a
 * worker: a worker's `fetch` waits on the page's main thread. Storage writes from a page stuck in a
 * loop still land where other pages read them, and outlive the page being killed.
 */
function saveFreezeTrail() {
    try {
        globalThis.localStorage.setItem(ownFreezeTrailKey, JSON.stringify(freezeTrail.trail));
    } catch {
        /* blocked or full storage just means no trail */
    }
}

/**
 * Adds one entry to this window's freeze trail while the `enableDebugLogs` setting is on. If the
 * window freezes or is killed, the next Agent Storm page to run sends the trail's newest entries to
 * the debug log, so the last entry shows what the page was doing when it stopped.
 */
export function recordFreezeTrail(event: string) {
    if (!pending.isEnabled) {
        return;
    }
    freezeTrail.trail.entries.push({
        at: Date.now(),
        event,
    });
    if (freezeTrail.trail.entries.length > freezeTrailEntryCount) {
        freezeTrail.trail.entries.shift();
    }
    saveFreezeTrail();
}

/**
 * Runs `run`, bracketed by `start` and `end` entries in the freeze trail. A freeze inside `run`
 * leaves a `start` with no `end`, which the freeze report lists as unfinished.
 */
export function traceFreezeSpan<T>(event: string, run: () => T) {
    if (!pending.isEnabled) {
        return run();
    }
    recordFreezeTrail(`start ${event}`);
    try {
        return run();
    } finally {
        recordFreezeTrail(`end ${event}`);
    }
}

/** The events of the trail's `start` entries that have no matching `end` entry after them. */
export function listUnfinishedSpans(entries: ReadonlyArray<Readonly<{event: string}>>) {
    return entries.reduce<string[]>((open, {event}) => {
        if (event.startsWith('start ')) {
            return [
                ...open,
                event.slice('start '.length),
            ];
        }
        const index = event.startsWith('end ') ? open.lastIndexOf(event.slice('end '.length)) : -1;
        return index < 0 ? open : open.toSpliced(index, 1);
    }, []);
}

/** Sends every other visible window's trail that stopped being refreshed, then forgets it. */
function reportStaleFreezeTrails() {
    try {
        readStaleFreezeTrails();
    } catch {
        /* blocked storage just means no trails to report */
    }
}

function readStaleFreezeTrails() {
    const now = Date.now();
    createArray(globalThis.localStorage.length, (index) => globalThis.localStorage.key(index))
        .filter((key): key is string => {
            return (
                !!key &&
                key.startsWith(freezeTrailKeyPrefix) &&
                key !== ownFreezeTrailKey &&
                !freezeTrail.reportedKeys.includes(key)
            );
        })
        .forEach((key) => {
            const trail: unknown = wrapInTry(
                () => JSON.parse(globalThis.localStorage.getItem(key) || ''),
                {
                    fallbackValue: undefined,
                },
            );
            if (!checkValidShape(trail, freezeTrailShape)) {
                globalThis.localStorage.removeItem(key);
                return;
            }
            const silentMilliseconds = now - trail.aliveAt;
            if (
                !trail.isVisible ||
                silentMilliseconds <
                    convertDuration(freezeTrailStaleness, {
                        milliseconds: true,
                    }).milliseconds
            ) {
                return;
            }
            freezeTrail.reportedKeys.push(key);
            globalThis.localStorage.removeItem(key);
            const lastAt = trail.entries.at(-1)?.at ?? trail.aliveAt;
            logDebug('freeze trail', {
                windowId: key.slice(freezeTrailKeyPrefix.length),
                silentSeconds: Math.round(
                    convertDuration(
                        {
                            milliseconds: silentMilliseconds,
                        },
                        {
                            seconds: true,
                        },
                    ).seconds,
                ),
                unfinished: listUnfinishedSpans(trail.entries),
                entries: trail.entries.map(({at, event}) => `${at - lastAt}ms ${event}`),
            });
        });
}

/** The first few callers in a stack, without the page origin, to say who asked for something. */
function describeCallers(stack: string) {
    return stack
        .split('\n')
        .slice(1, 4)
        .map((line) => line.replace(/https?:\/\/[^/]+\//, '').trim())
        .join(' < ');
}

/**
 * Brackets every animation frame callback in a freeze-trail span named by whoever requested it, so
 * a freeze inside one names its source.
 */
function traceAnimationFrames() {
    const requestFrame = globalThis.requestAnimationFrame.bind(globalThis);
    globalThis.requestAnimationFrame = (callback) => {
        const requestedBy = pending.isEnabled
            ? describeCallers(new Error('animation frame request').stack || '')
            : '';
        return requestFrame((time) => {
            traceFreezeSpan(`animation frame from ${requestedBy}`, () => callback(time));
        });
    };
}

function startFreezeTrail() {
    if (freezeTrail.hasStarted) {
        return;
    }
    freezeTrail.hasStarted = true;
    freezeTrail.trail.isVisible = document.visibilityState === 'visible';
    traceAnimationFrames();
    globalThis.addEventListener('visibilitychange', () => {
        freezeTrail.trail.isVisible = document.visibilityState === 'visible';
        freezeTrail.trail.aliveAt = Date.now();
        saveFreezeTrail();
    });
    /** A window that closes normally leaves no trail to report. */
    globalThis.addEventListener('pagehide', () => {
        try {
            globalThis.localStorage.removeItem(ownFreezeTrailKey);
        } catch {
            /* nothing to clean up without storage */
        }
    });
    globalThis.setInterval(
        () => {
            if (!pending.isEnabled) {
                return;
            }
            freezeTrail.trail.aliveAt = Date.now();
            saveFreezeTrail();
            reportStaleFreezeTrails();
        },
        convertDuration(
            {
                seconds: 2,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
    reportStaleFreezeTrails();
}

/** Turns {@link logDebug} and the freeze trail on or off, for the `enableDebugLogs` setting. */
export function setDebugLogEnabled(isEnabled: boolean) {
    pending.isEnabled = isEnabled;
    if (isEnabled) {
        startFreezeTrail();
    }
}

/** Whether the `enableDebugLogs` setting is on. */
export function isDebugLogEnabled() {
    return pending.isEnabled;
}

/**
 * Appends an entry to the server's debug log (`debugLogDir`) while the `enableDebugLogs` setting is
 * on, and drops it otherwise. Unlike `reportClientError`, nothing is deduplicated or capped, so it
 * suits code paths that run often. Entries are sent in batches.
 */
export function logDebug(event: string, details: unknown) {
    if (!pending.isEnabled) {
        return;
    }
    pending.entries.push({
        at: toUtcIsoString(getNowInUtcTimezone()),
        event,
        details,
    });
    if (pending.isSendScheduled) {
        return;
    }
    pending.isSendScheduled = true;
    setTimeout(
        () => {
            const entries = pending.entries;
            pending.entries = [];
            pending.isSendScheduled = false;
            void fetchApi(clientDebugLogEndpoint, HttpMethod.Post, {
                requestData: {
                    windowId,
                    pageUrl: globalThis.location.href,
                    entries,
                },
            }).catch(() => {
                /* the backend is where these go; a failed send has nowhere left to go */
            });
        },
        convertDuration(
            {
                milliseconds: 500,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
}
