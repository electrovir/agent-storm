import {
    clientDebugLogEndpoint,
    TimedDebugLogEvent,
    type clientDebugLogRequestShape,
    type PerfTiming,
} from '@agent-storm/common';
import {setGhCallLogger, startPerfTrace, takePerfTrace, type PerfTrace} from 'agent-storm-util';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {type FastifyInstance, type FastifyRequest} from 'fastify';
import {appendFile, mkdir, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {debugLogDir} from './file-paths.js';
import {loadSettings, readSettingsRevision} from './settings.js';

const tracking = {
    lastPrunedAt: 0,
};
/** Spans listed per entry, the ones that took the most time. */
const listedSpanCount = 12;

/** Deletes debug log files older than a day. Runs at most once an hour; later calls return early. */
export async function pruneDebugLogs() {
    const now = Date.now();
    if (
        now - tracking.lastPrunedAt <
        convertDuration(
            {
                hours: 1,
            },
            {
                milliseconds: true,
            },
        ).milliseconds
    ) {
        return;
    }
    tracking.lastPrunedAt = now;
    const maxAgeMilliseconds = convertDuration(
        {
            days: 1,
        },
        {
            milliseconds: true,
        },
    ).milliseconds;
    const fileNames = await readdir(debugLogDir).catch(() => []);
    await Promise.all(
        fileNames.map(async (fileName) => {
            const filePath = join(debugLogDir, fileName);
            const stats = await stat(filePath).catch(() => undefined);
            if (stats && now - stats.mtimeMs > maxAgeMilliseconds) {
                await rm(filePath, {
                    force: true,
                });
            }
        }),
    );
}

/**
 * Appends a window's batch of entries to the current hour's file. Failures are swallowed: debug
 * logging that throws would add a second bug to the one being traced.
 */
export async function appendDebugLog({
    windowId,
    pageUrl,
    entries,
}: Readonly<typeof clientDebugLogRequestShape.runtimeType>) {
    try {
        await mkdir(debugLogDir, {
            recursive: true,
        });
        const loggedAt = toUtcIsoString(getNowInUtcTimezone());
        /** One file per hour, so pruning deletes whole files instead of rewriting one. */
        await appendFile(
            join(debugLogDir, `${loggedAt.slice(0, 13)}.jsonl`),
            entries
                .map((entry) => {
                    return `${JSON.stringify({
                        windowId,
                        pageUrl,
                        ...entry,
                    })}\n`;
                })
                .join(''),
        );
        await pruneDebugLogs();
    } catch {
        /* ignore debug log failures */
    }
}

/** The `enableDebugLogs` setting, reread only when the settings file changes. */
const debugLogSetting = {
    revision: -1,
    isEnabled: false,
};

async function isDebugLogEnabled() {
    const revision = await readSettingsRevision();
    if (revision !== debugLogSetting.revision) {
        debugLogSetting.revision = revision;
        debugLogSetting.isEnabled = !!(await loadSettings().catch(() => undefined))
            ?.enableDebugLogs;
    }
    return debugLogSetting.isEnabled;
}

/**
 * While the `enableDebugLogs` setting is on, logs which plugin call one `POST /plugins/call` was
 * and how long it took to answer, since the perf log only times that route as a whole.
 */
export async function logPluginCallDebug({
    pluginId,
    call,
    startedAt,
}: Readonly<{
    pluginId: string;
    call: string;
    /** From `Date.now()`. */
    startedAt: number;
}>) {
    /** Taken first, so {@link startRequestDebugLog} doesn't log this request a second time. */
    const trace = takePerfTrace();
    if (!(await isDebugLogEnabled())) {
        return;
    }
    await appendDebugLog({
        windowId: 'server',
        pageUrl: '',
        entries: [
            {
                at: toUtcIsoString(getNowInUtcTimezone()),
                event: TimedDebugLogEvent.PluginCall,
                details: {
                    pluginId,
                    call,
                    milliseconds: Date.now() - startedAt,
                    ...summarizePerfTrace(trace),
                },
            },
        ],
    });
}

function roundTiming(timing: Readonly<PerfTiming>): PerfTiming {
    return {
        ...timing,
        totalMilliseconds: Math.round(timing.totalMilliseconds),
        maxMilliseconds: Math.round(timing.maxMilliseconds),
    };
}

/**
 * What a request's time went to: each span name's summed time, and the slowest spans with when they
 * started. Spans that ran at once overlap, so the totals can add up past the request's time.
 */
function summarizePerfTrace(trace: Readonly<PerfTrace> | undefined) {
    if (!trace?.spans.length) {
        return {};
    }
    const totals = trace.spans.reduce((summed, span) => {
        const existing = summed.get(span.name);
        return summed.set(span.name, {
            name: span.name,
            count: (existing?.count || 0) + 1,
            totalMilliseconds: (existing?.totalMilliseconds || 0) + span.milliseconds,
            maxMilliseconds: Math.max(existing?.maxMilliseconds || 0, span.milliseconds),
        });
    }, new Map<string, PerfTiming>());
    return {
        spanCount: trace.spans.length + trace.droppedSpanCount,
        spanTotals: [
            ...totals.values(),
        ]
            .toSorted((first, second) => second.totalMilliseconds - first.totalMilliseconds)
            .slice(0, listedSpanCount)
            .map(roundTiming),
        slowestSpans: trace.spans
            .toSorted((first, second) => second.milliseconds - first.milliseconds)
            .slice(0, listedSpanCount)
            .map((span) => {
                return {
                    name: span.name,
                    startMilliseconds: Math.round(span.startMilliseconds),
                    milliseconds: Math.round(span.milliseconds),
                    ...(span.isFailed
                        ? {
                              isFailed: true,
                          }
                        : {}),
                };
            }),
    };
}

/**
 * Over HTTP/2, Fastify runs `onResponse` outside the request's async context, so
 * {@link startRequestDebugLog} can't find the request's trace through it.
 */
const requestTraces = new WeakMap<FastifyRequest, PerfTrace>();

/**
 * While the `enableDebugLogs` setting is on, traces every request (see `startPerfTrace`) and logs
 * how long it took with what its time went to. Plugin calls are logged by {@link logPluginCallDebug}
 * instead, with their call's name. Call before the API attaches, so the hooks cover every route.
 */
export function startRequestDebugLog(server: Readonly<Pick<FastifyInstance, 'addHook'>>) {
    server.addHook('onRequest', (request, reply, done) => {
        /** A WebSocket's request lasts as long as the socket, which isn't request time. */
        if (request.headers.upgrade) {
            done();
            return;
        }
        /** `done` runs inside the trace so the route's handler and its async work inherit it. */
        isDebugLogEnabled().then(
            (isEnabled) => {
                if (isEnabled) {
                    startPerfTrace((trace) => {
                        requestTraces.set(request, trace);
                        done();
                    });
                } else {
                    done();
                }
            },
            () => done(),
        );
    });
    server.addHook('onResponse', (request, reply, done) => {
        const trace = takePerfTrace(requestTraces.get(request));
        /** Logging the debug log's own requests would log a request for every batch it writes. */
        if (trace && request.routeOptions.url !== clientDebugLogEndpoint.path) {
            void appendDebugLog({
                windowId: 'server',
                pageUrl: '',
                entries: [
                    {
                        at: toUtcIsoString(getNowInUtcTimezone()),
                        event: TimedDebugLogEvent.Request,
                        details: {
                            name: `${request.method} ${request.routeOptions.url || request.url.split('?')[0]}`,
                            milliseconds: Math.round(reply.elapsedTime),
                            ...summarizePerfTrace(trace),
                        },
                    },
                ],
            });
        }
        done();
    });
}

/**
 * While the `enableDebugLogs` setting is on, logs every `gh` call with the rate-limit points it
 * spent, so the debug log shows what drains GitHub's budget.
 */
export function startGhCallDebugLog() {
    setGhCallLogger({
        isEnabled: isDebugLogEnabled,
        async log({args, ...call}) {
            await appendDebugLog({
                windowId: 'server',
                pageUrl: '',
                entries: [
                    {
                        at: toUtcIsoString(getNowInUtcTimezone()),
                        event: 'gh-call',
                        details: {
                            ...call,
                            /** Long GraphQL queries collapsed so an entry stays one readable line. */
                            args: args.map((arg) => arg.replaceAll(/\s+/g, ' ').slice(0, 400)),
                        },
                    },
                ],
            });
        },
    });
}
