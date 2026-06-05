import {log, wait} from '@augment-vir/common';
import {
    type AnyDuration,
    calculateRelativeDate,
    createFullDate,
    getNowInUserTimezone,
    isDateAfter,
} from 'date-vir';
import {copyFile, mkdir, readdir, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {configBackupDir, configPath} from './file-paths.js';

/**
 * How many days of backups to keep on disk. Generous enough that a user noticing a config reset
 * weeks later can still recover, small enough to keep the backup directory tiny (each backup is a
 * few kilobytes).
 */
const backupRetentionDays = 30;

/**
 * How often the loop wakes up to consider whether a new backup is needed. Hourly is plenty: the
 * inner predicate (`shouldCreateBackup`) gates on whether _today's_ dated snapshot already exists,
 * so this just controls how quickly we react after midnight rolls over.
 */
const checkInterval: AnyDuration = {
    hours: 1,
};

const retentionWindow: AnyDuration = {
    days: -backupRetentionDays,
};

function formatDateString(): string {
    const now = getNowInUserTimezone();
    return [
        now.year,
        String(now.month).padStart(2, '0'),
        String(now.day).padStart(2, '0'),
    ].join('-');
}

function backupPathForToday(): string {
    return join(configBackupDir, `agent-storm-${formatDateString()}.json`);
}

/**
 * Filename format we'll trust as one of our own backups when pruning. Anything else in the backup
 * dir (manual user copies, partial writes, junk) is left alone.
 */
const backupFileNamePattern = /^agent-storm-(\d{4}-\d{2}-\d{2})\.json$/;

async function ensureTodaysBackup(): Promise<void> {
    const destPath = backupPathForToday();
    const alreadyExists = await stat(destPath)
        .then(() => true)
        .catch(() => false);
    if (alreadyExists) {
        return;
    }
    const sourceExists = await stat(configPath)
        .then(() => true)
        .catch(() => false);
    if (!sourceExists) {
        return;
    }
    await mkdir(configBackupDir, {
        recursive: true,
    });
    await copyFile(configPath, destPath);
    log.info(`Wrote config backup to ${destPath}.`);
}

async function pruneOldBackups(): Promise<void> {
    const entries = await readdir(configBackupDir).catch(() => undefined);
    if (!entries) {
        return;
    }
    const cutoff = calculateRelativeDate(getNowInUserTimezone(), retentionWindow);
    await Promise.all(
        entries.map(async (entry) => {
            const match = backupFileNamePattern.exec(entry);
            const datePart = match?.[1];
            if (!datePart) {
                return;
            }
            /**
             * Parse the backup's filename date in the same timezone we wrote it in.
             * `createFullDate` accepts a "YYYY-MM-DD" string and produces a proper `FullDate` (with
             * the brand-typed hour/minute fields the comparison helpers require) — building the
             * object literally loses those brands and trips type-check.
             */
            const backupDate = createFullDate(datePart, cutoff.timezone);
            /**
             * Delete only files strictly older than the cutoff (cutoff is _after_ the backup's
             * date). Today and the last `backupRetentionDays - 1` days are always preserved.
             */
            if (
                isDateAfter({
                    fullDate: cutoff,
                    relativeTo: backupDate,
                })
            ) {
                await unlink(join(configBackupDir, entry)).catch(() => {
                    /* best-effort cleanup; don't crash the loop over a stuck file */
                });
            }
        }),
    );
}

const loopState = {
    started: false,
};

/**
 * Kick off the daily config backup loop. Safe to call multiple times; only the first call starts a
 * timer. Runs one backup pass immediately so a fresh install / restart always gets today's
 * snapshot, then re-checks every {@link checkInterval} so a server that stays running across
 * midnight still produces the next day's backup without manual restart.
 */
export function startConfigBackupLoop(): void {
    if (loopState.started) {
        return;
    }
    loopState.started = true;
    const runPass = async (): Promise<void> => {
        try {
            await ensureTodaysBackup();
            await pruneOldBackups();
        } catch (error) {
            log.warning(`Config backup pass failed: ${String(error)}`);
        }
    };
    void runPass();
    const scheduleNext = (): void => {
        void wait(checkInterval).then(runPass).finally(scheduleNext);
    };
    scheduleNext();
}
