import type {clientDebugLogRequestShape} from '@agent-storm/common';
import {setGhCallLogger} from 'agent-storm-util';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {appendFile, mkdir, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {debugLogDir} from './file-paths.js';
import {loadSettings, readSettingsRevision} from './settings.js';

const tracking = {
    lastPrunedAt: 0,
};

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
