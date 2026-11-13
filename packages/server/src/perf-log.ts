import {type PerfTiming} from '@agent-storm/common';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {type FastifyInstance} from 'fastify';
import {appendFile, rename, stat} from 'node:fs/promises';
import {monitorEventLoopDelay, performance} from 'node:perf_hooks';
import {perfLogPath} from './file-paths.js';

/** Past this size the log is moved to a `.old` copy, so a long session can't fill the disk. */
const maxLogBytes = 20_000_000;
/** A quiet window is still written after this many quiet ones, so slow growth shows in the log. */
const heartbeatWindowCount = 30;
/** Entries kept per list in a window, the ones that took the most total time. */
const listedEntryCount = 15;

/**
 * Appends one JSON line to the perf log. Failures are swallowed: perf logging that itself throws
 * would add an error to whatever slowdown it was recording.
 */
export async function appendPerfLog(entry: Readonly<Record<string, unknown>>) {
    try {
        const size = (await stat(perfLogPath).catch(() => undefined))?.size || 0;
        if (size > maxLogBytes) {
            await rename(perfLogPath, `${perfLogPath}.old`);
        }
        await appendFile(
            perfLogPath,
            `${JSON.stringify({
                at: toUtcIsoString(getNowInUtcTimezone()),
                ...entry,
            })}\n`,
        );
    } catch {
        /* ignore perf log failures */
    }
}

/**
 * Writes the server's slow windows to the perf log: how long the event loop was blocked and how
 * long each route's requests took. Quiet windows are skipped except for a periodic heartbeat with
 * memory use. Call before the server starts listening, so the request hook covers every route.
 */
export function startServerPerfLog(server: Readonly<Pick<FastifyInstance, 'addHook'>>) {
    const eventLoopDelay = monitorEventLoopDelay({
        resolution: 20,
    });
    eventLoopDelay.enable();
    /**
     * Mutated in place: every request records into it, and copying it per request would add load to
     * the server being measured.
     */
    const requestTimings = new Map<string, PerfTiming>();
    const tracking = {
        windowStartedAt: performance.now(),
        quietWindowCount: 0,
    };
    const slowEventLoopMilliseconds = convertDuration(
        {
            milliseconds: 150,
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

    server.addHook('onResponse', (request, reply, done) => {
        /** A WebSocket's request lasts as long as the socket, which isn't request time. */
        if (request.headers.upgrade) {
            done();
            return;
        }
        const name = `${request.method} ${request.routeOptions.url || request.url.split('?')[0]}`;
        const existing = requestTimings.get(name);
        requestTimings.set(name, {
            name,
            count: (existing?.count || 0) + 1,
            totalMilliseconds: (existing?.totalMilliseconds || 0) + reply.elapsedTime,
            maxMilliseconds: Math.max(existing?.maxMilliseconds || 0, reply.elapsedTime),
        });
        done();
    });

    setInterval(
        () => {
            const now = performance.now();
            const requests = [
                ...requestTimings.values(),
            ];
            requestTimings.clear();
            /** The histogram is in nanoseconds. */
            const eventLoop = {
                maxMilliseconds: Math.round(eventLoopDelay.max / 1_000_000),
                p99Milliseconds: Math.round(eventLoopDelay.percentile(99) / 1_000_000),
                meanMilliseconds: Math.round(eventLoopDelay.mean / 1_000_000),
            };
            eventLoopDelay.reset();
            const isSlow =
                eventLoop.maxMilliseconds >= slowEventLoopMilliseconds ||
                requests.some((timing) => timing.maxMilliseconds >= slowRequestMilliseconds);
            const windowMilliseconds = Math.round(now - tracking.windowStartedAt);
            tracking.windowStartedAt = now;
            tracking.quietWindowCount = isSlow ? 0 : tracking.quietWindowCount + 1;
            if (!isSlow && tracking.quietWindowCount < heartbeatWindowCount) {
                return;
            }
            tracking.quietWindowCount = 0;
            const memory = process.memoryUsage();
            void appendPerfLog({
                side: 'server',
                event: 'window',
                windowMilliseconds,
                eventLoop,
                requests: requests
                    .toSorted((first, second) => second.totalMilliseconds - first.totalMilliseconds)
                    .slice(0, listedEntryCount)
                    .map((timing) => {
                        return {
                            ...timing,
                            totalMilliseconds: Math.round(timing.totalMilliseconds),
                            maxMilliseconds: Math.round(timing.maxMilliseconds),
                        };
                    }),
                rssMegabytes: Math.round(memory.rss / 1_000_000),
                heapUsedMegabytes: Math.round(memory.heapUsed / 1_000_000),
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
    ).unref();
}

/** Logs how long this process took from launch until it served requests. */
export async function logServerStartup() {
    await appendPerfLog({
        side: 'server',
        event: 'startup',
        startupMilliseconds: Math.round(performance.now()),
    });
}
