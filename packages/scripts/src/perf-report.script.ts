/**
 * Summarizes the debug log (written while the `enableDebugLogs` setting is on) into how long each
 * server request, plugin call, and browser-side request took, and which spans (`git`, `gh`, SQLite
 * queries, PTY daemon calls, named steps) their time went to. Run it over the same window before
 * and after a fix to measure the fix. `AGENT_STORM_INSTANCE` picks the instance, as for the app.
 *
 * Usage:
 *
 *     npm run perf-report
 *     npm run perf-report -- --minutes 15
 *     npm run perf-report -- --since 2026-11-25T08:00 --until 2026-11-25T09:00
 *     npm run perf-report -- --name build.archiveThread
 *
 * @module
 */

import {perfTimingShape, TimedDebugLogEvent} from '@agent-storm/common';
import {debugLogDir} from '@agent-storm/server/src/file-paths.js';
import {getObjectTypedEntries, log} from '@augment-vir/common';
import {parseArgs} from 'cli-vir';
import {
    calculateRelativeDate,
    createFullDate,
    getNowInUtcTimezone,
    toUtcIsoString,
    userTimezone,
} from 'date-vir';
import {readdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkValidShape, defineShape, enumShape, optionalShape} from 'object-shape-tester';

const spanShape = defineShape({
    name: '',
    startMilliseconds: 0,
    milliseconds: 0,
    isFailed: optionalShape(false),
});

const timedEntryShape = defineShape({
    at: '',
    event: enumShape(TimedDebugLogEvent),
    details: {
        milliseconds: 0,
        name: optionalShape(''),
        pluginId: optionalShape(''),
        call: optionalShape(''),
        untilPaintMilliseconds: optionalShape(0),
        spanTotals: optionalShape([
            perfTimingShape,
        ]),
        slowestSpans: optionalShape([
            spanShape,
        ]),
    },
});

type TimedEntry = typeof timedEntryShape.runtimeType;

enum EntrySide {
    Server = 'server',
    Browser = 'browser',
}

const sideByEvent: Readonly<Record<TimedDebugLogEvent, EntrySide>> = {
    [TimedDebugLogEvent.PluginCall]: EntrySide.Server,
    [TimedDebugLogEvent.Request]: EntrySide.Server,
    [TimedDebugLogEvent.ClientRequest]: EntrySide.Browser,
};

/** Rows listed per table, the slowest ones by p95. */
const listedRowCount = 30;
/** Entries listed with `--name`, the slowest ones. */
const listedEntryCount = 10;

function readEntryName(entry: Readonly<TimedEntry>) {
    return entry.details.pluginId && entry.details.call
        ? `${entry.details.pluginId}.${entry.details.call}`
        : entry.details.name || entry.event;
}

/** Each debug log file holds one UTC hour, named by its ISO hour, like `2026-11-25T15.jsonl`. */
async function readEntries({since, until}: Readonly<{since: string; until: string}>) {
    const fileNames = (await readdir(debugLogDir).catch(() => []))
        .filter((fileName) => {
            const hour = fileName.slice(0, 13);
            return hour >= since.slice(0, 13) && hour <= until.slice(0, 13);
        })
        .toSorted();
    const contents = await Promise.all(
        fileNames.map(async (fileName) => await readFile(join(debugLogDir, fileName), 'utf8')),
    );
    return contents
        .flatMap((content) => content.split('\n'))
        .flatMap((line): TimedEntry[] => {
            if (!line.trim()) {
                return [];
            }
            try {
                const parsed: unknown = JSON.parse(line);
                return checkValidShape(parsed, timedEntryShape, {
                    allowExtraKeys: true,
                }) &&
                    parsed.at >= since &&
                    parsed.at <= until
                    ? [
                          parsed,
                      ]
                    : [];
            } catch {
                return [];
            }
        });
}

function readPercentile(sortedValues: ReadonlyArray<number>, fraction: number) {
    return (
        sortedValues[
            Math.min(sortedValues.length - 1, Math.floor(fraction * sortedValues.length))
        ] ?? 0
    );
}

function formatTable(rows: ReadonlyArray<ReadonlyArray<string>>) {
    const widths = rows.reduce<number[]>((maxWidths, row) => {
        return row.map((cell, index) => Math.max(maxWidths[index] || 0, cell.length));
    }, []);
    return rows.map((row) => {
        return row
            .map((cell, index) => {
                return index ? cell.padStart(widths[index] || 0) : cell.padEnd(widths[index] || 0);
            })
            .join('  ');
    });
}

/** The span names that took the most of these entries' summed time, as shares of it. */
function describeTopSpans(entries: ReadonlyArray<Readonly<TimedEntry>>) {
    const entryMilliseconds = entries.reduce(
        (total, entry) => total + entry.details.milliseconds,
        0,
    );
    const spanMilliseconds = entries
        .flatMap((entry) => entry.details.spanTotals || [])
        .reduce<Partial<Record<string, number>>>((totals, timing) => {
            return {
                ...totals,
                [timing.name]: (totals[timing.name] || 0) + timing.totalMilliseconds,
            };
        }, {});
    return getObjectTypedEntries(spanMilliseconds)
        .toSorted(
            (
                [
                    ,
                    first,
                ],
                [
                    ,
                    second,
                ],
            ) => (second || 0) - (first || 0),
        )
        .slice(0, 3)
        .map(
            ([
                name,
                milliseconds,
            ]) => {
                return `${name} ${Math.round(((milliseconds || 0) / (entryMilliseconds || 1)) * 100)}%`;
            },
        )
        .join(', ');
}

function summarizeSide({
    side,
    entries,
}: Readonly<{
    side: EntrySide;
    entries: ReadonlyArray<Readonly<TimedEntry>>;
}>) {
    const byName = Map.groupBy(
        entries.filter((entry) => sideByEvent[entry.event] === side),
        readEntryName,
    );
    const rows = [
        ...byName.entries(),
    ]
        .map(
            ([
                name,
                named,
            ]) => {
                const durations = named
                    .map((entry) => entry.details.milliseconds)
                    .toSorted((first, second) => first - second);
                const paints = named
                    .flatMap((entry) => entry.details.untilPaintMilliseconds ?? [])
                    .toSorted((first, second) => first - second);
                return {
                    p95: readPercentile(durations, 0.95),
                    cells: [
                        name,
                        String(named.length),
                        String(readPercentile(durations, 0.5)),
                        String(readPercentile(durations, 0.95)),
                        String(durations.at(-1) ?? 0),
                        side === EntrySide.Server
                            ? describeTopSpans(named)
                            : String(paints.length ? readPercentile(paints, 0.95) : ''),
                    ],
                };
            },
        )
        .toSorted((first, second) => second.p95 - first.p95)
        .slice(0, listedRowCount)
        .map((row) => row.cells);
    return [
        side === EntrySide.Server
            ? 'Server (requests and plugin calls), milliseconds:'
            : 'Browser (round trip, and p95 until the next paint), milliseconds:',
        ...formatTable([
            [
                'name',
                'count',
                'p50',
                'p95',
                'max',
                side === EntrySide.Server ? 'most time in' : 'paint p95',
            ],
            ...rows,
        ]),
    ];
}

/** The slowest server entries for `name`, each with its slowest spans in the order they started. */
function describeSlowestEntries({
    name,
    entries,
}: Readonly<{
    name: string;
    entries: ReadonlyArray<Readonly<TimedEntry>>;
}>) {
    return entries
        .filter((entry) => {
            return sideByEvent[entry.event] === EntrySide.Server && readEntryName(entry) === name;
        })
        .toSorted((first, second) => second.details.milliseconds - first.details.milliseconds)
        .slice(0, listedEntryCount)
        .flatMap((entry) => {
            return [
                `${entry.at} ${entry.details.milliseconds}ms`,
                ...(entry.details.slowestSpans || [])
                    .toSorted((first, second) => first.startMilliseconds - second.startMilliseconds)
                    .map((span) => {
                        return `    +${span.startMilliseconds}ms ${span.milliseconds}ms ${span.name}${span.isFailed ? ' (failed)' : ''}`;
                    }),
            ];
        });
}

async function reportPerf(rawArgs: ReadonlyArray<string>) {
    const args = parseArgs(
        rawArgs,
        {
            minutes: {
                flag: {
                    valueRequirement: 'required',
                },
                type: 'number',
                description: 'Covers this many minutes up to now. Defaults to 60.',
            },
            since: {
                flag: {
                    valueRequirement: 'required',
                },
                type: 'string',
                description:
                    'Covers from this local time, like 2026-11-25T08:00. Overrides --minutes.',
            },
            until: {
                flag: {
                    valueRequirement: 'required',
                },
                type: 'string',
                description: 'Covers up to this local time. Defaults to now.',
            },
            name: {
                flag: {
                    valueRequirement: 'required',
                },
                type: 'string',
                description:
                    'Lists the slowest entries of this server request or plugin call (like build.archiveThread) with their spans.',
            },
        },
        {
            binName: undefined,
            packageJsonPath: undefined,
            importMeta: import.meta,
        },
    );
    const until = args.until
        ? toUtcIsoString(createFullDate(args.until, userTimezone))
        : toUtcIsoString(getNowInUtcTimezone());
    const since = args.since
        ? toUtcIsoString(createFullDate(args.since, userTimezone))
        : toUtcIsoString(
              calculateRelativeDate(getNowInUtcTimezone(), {
                  minutes: -(args.minutes || 60),
              }),
          );
    const entries = await readEntries({
        since,
        until,
    });
    if (!entries.length) {
        log.warning(
            `No timed entries in ${debugLogDir} from ${since} to ${until}. Is the "Enable debug logs" setting on?`,
        );
        return;
    }
    log.info(
        [
            `${entries.length} entries from ${since} to ${until}.`,
            '',
            ...(args.name
                ? describeSlowestEntries({
                      name: args.name,
                      entries,
                  })
                : [
                      ...summarizeSide({
                          side: EntrySide.Server,
                          entries,
                      }),
                      '',
                      ...summarizeSide({
                          side: EntrySide.Browser,
                          entries,
                      }),
                  ]),
        ].join('\n'),
    );
}

await reportPerf(process.argv);
