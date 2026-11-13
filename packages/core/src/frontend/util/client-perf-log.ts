import {clientPerfEndpoint, type PerfTiming} from '@agent-storm/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, type AnyDuration} from 'date-vir';
import {fetchApi} from './api-client.js';
import {getStoredSecret} from './auth.js';
import {
    PerfCategory,
    peekPerfWindow,
    recordPerf,
    takePerfWindow,
    type FreezeWatchdogPing,
} from './perf-stats.js';
import {getBackendBaseUrl} from './service-origin.js';

const stallCheckInterval: AnyDuration = {
    milliseconds: 50,
};
/** A quiet window is still sent after this many quiet ones, so slow growth shows in the log. */
const heartbeatWindowCount = 30;
/** Renders in one window past which the window counts as busy even if each render was quick. */
const busyRenderCount = 1000;
/** Entries kept per list in a report, the ones that took the most total time. */
const listedEntryCount = 15;

/** Counts elements inside every shadow root too, which `querySelectorAll` alone skips. */
function countElements(root: Readonly<Document | ShadowRoot>): number /* recursive */ {
    return [
        ...root.querySelectorAll('*'),
    ].reduce((count, element) => {
        return count + 1 + (element.shadowRoot ? countElements(element.shadowRoot) : 0);
    }, 0);
}

function roundTiming(timing: Readonly<PerfTiming>): PerfTiming {
    return {
        ...timing,
        totalMilliseconds: Math.round(timing.totalMilliseconds),
        maxMilliseconds: Math.round(timing.maxMilliseconds),
    };
}

/** Sums timings with the same name, across the windows they came from. */
function mergeTimings(timings: ReadonlyArray<Readonly<PerfTiming>>) {
    return [
        ...timings
            .reduce((merged, timing) => {
                const existing = merged.get(timing.name);
                return merged.set(timing.name, {
                    name: timing.name,
                    count: (existing?.count || 0) + timing.count,
                    totalMilliseconds:
                        (existing?.totalMilliseconds || 0) + timing.totalMilliseconds,
                    maxMilliseconds: Math.max(
                        existing?.maxMilliseconds || 0,
                        timing.maxMilliseconds,
                    ),
                });
            }, new Map<string, PerfTiming>())
            .values(),
    ];
}

function listSlowest(timings: ReadonlyArray<Readonly<PerfTiming>>) {
    return timings
        .toSorted((first, second) => second.totalMilliseconds - first.totalMilliseconds)
        .slice(0, listedEntryCount)
        .map(roundTiming);
}

/**
 * Ships the frontend's slow windows to the backend's perf log: main-thread stalls, each element's
 * renders, and each API request's time. The app runs as an installed PWA with no devtools, so this
 * log is the only way to see what a slow window was busy with. Quiet windows are skipped except for
 * a periodic heartbeat. Call once.
 */
export function installClientPerfLog() {
    const stallCheckMilliseconds = convertDuration(stallCheckInterval, {
        milliseconds: true,
    }).milliseconds;
    /** Short enough to feel as lag, long enough to skip ordinary timer jitter. */
    const stallMilliseconds = convertDuration(
        {
            milliseconds: 150,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    /**
     * A gap this long is the computer sleeping or the window being suspended, not a blocked main
     * thread.
     */
    const suspendedMilliseconds = convertDuration(
        {
            minutes: 1,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    const slowRenderMilliseconds = convertDuration(
        {
            milliseconds: 50,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    const slowRequestMilliseconds = convertDuration(
        {
            seconds: 2,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    const tracking: {
        lastStallCheckAt: number;
        windowStartedAt: number;
        quietWindowCount: number;
        /** The last finished window, so a freeze report covers more than the current one. */
        previousRenders: ReadonlyArray<PerfTiming>;
        previousRequests: ReadonlyArray<PerfTiming>;
    } = {
        lastStallCheckAt: performance.now(),
        windowStartedAt: performance.now(),
        quietWindowCount: 0,
        previousRenders: [],
        previousRequests: [],
    };
    /**
     * A frozen page can't report anything, so a worker thread, which keeps running, notices when
     * these pings stop and reports the freeze with the activity from the last ping.
     */
    const watchdog = new Worker(new URL('./freeze-watchdog-worker.ts', import.meta.url), {
        type: 'module',
    });

    function pingWatchdog() {
        const readCategory = peekPerfWindow();
        const renders = mergeTimings([
            ...tracking.previousRenders,
            ...readCategory(PerfCategory.Render),
        ]);
        watchdog.postMessage({
            isVisible: document.visibilityState === 'visible',
            backendUrl: getBackendBaseUrl(),
            secret: getStoredSecret(),
            activity: {
                totalRenderCount: renders.reduce((sum, render) => sum + render.count, 0),
                renders: listSlowest(renders),
                requests: listSlowest(
                    mergeTimings([
                        ...tracking.previousRequests,
                        ...readCategory(PerfCategory.Request),
                    ]),
                ),
                pageAgeSeconds: Math.round(performance.now() / 1000),
                pageUrl: globalThis.location.href,
            },
        } satisfies FreezeWatchdogPing);
    }

    globalThis.addEventListener('visibilitychange', () => {
        /** Hidden windows have their timers throttled, which would read as stalls. */
        tracking.lastStallCheckAt = performance.now();
        pingWatchdog();
    });
    globalThis.setInterval(
        pingWatchdog,
        convertDuration(
            {
                seconds: 1,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );

    globalThis.setInterval(() => {
        const now = performance.now();
        const blockedMilliseconds = now - tracking.lastStallCheckAt - stallCheckMilliseconds;
        tracking.lastStallCheckAt = now;
        if (
            blockedMilliseconds >= stallMilliseconds &&
            blockedMilliseconds < suspendedMilliseconds &&
            document.visibilityState === 'visible'
        ) {
            recordPerf({
                category: PerfCategory.Stall,
                name: 'main thread',
                milliseconds: blockedMilliseconds,
            });
        }
    }, stallCheckMilliseconds);

    globalThis.setInterval(
        () => {
            const now = performance.now();
            const readCategory = takePerfWindow();
            const stalls = readCategory(PerfCategory.Stall)[0];
            const renders = readCategory(PerfCategory.Render);
            const requests = readCategory(PerfCategory.Request);
            tracking.previousRenders = renders;
            tracking.previousRequests = requests;
            const totalRenderCount = renders.reduce((sum, render) => sum + render.count, 0);
            const isSlow =
                !!stalls ||
                totalRenderCount >= busyRenderCount ||
                renders.some((render) => render.maxMilliseconds >= slowRenderMilliseconds) ||
                requests.some((request) => request.maxMilliseconds >= slowRequestMilliseconds);
            const windowMilliseconds = Math.round(now - tracking.windowStartedAt);
            tracking.windowStartedAt = now;
            tracking.quietWindowCount = isSlow ? 0 : tracking.quietWindowCount + 1;
            if (!isSlow && tracking.quietWindowCount < heartbeatWindowCount) {
                return;
            }
            tracking.quietWindowCount = 0;
            void fetchApi(clientPerfEndpoint, HttpMethod.Post, {
                requestData: {
                    windowMilliseconds,
                    stalls: roundTiming(
                        stalls || {
                            name: 'main thread',
                            count: 0,
                            totalMilliseconds: 0,
                            maxMilliseconds: 0,
                        },
                    ),
                    totalRenderCount,
                    renders: listSlowest(renders),
                    requests: listSlowest(requests),
                    domNodeCount: countElements(document),
                    pageAgeSeconds: Math.round(now / 1000),
                    pageUrl: globalThis.location.href,
                },
            }).catch(() => {
                /* a perf report that fails to send has nowhere else to go */
            });
        },
        convertDuration(
            {
                seconds: 10,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
}
