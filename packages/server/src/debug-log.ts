import type {clientDebugLogRequestShape} from '@agent-storm/common';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {appendFile, mkdir, readdir, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {debugLogDir} from './file-paths.js';

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
