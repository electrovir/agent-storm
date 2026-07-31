import {getNowInIsoString} from 'date-vir';
import {appendFileSync} from 'node:fs';
import {daemonLogPath} from '../file-paths.js';

/**
 * Build a timestamped appender for the daemon's shared log file. `prefix`, when given, is bracketed
 * after the timestamp so a single log file stays readable with multiple subsystems writing to it.
 *
 * Appends are synchronous on purpose: callers include socket handlers and the process-exit paths,
 * where an async write would never flush. Failures are swallowed because a log write must never be
 * what takes the daemon down.
 */
export function createDaemonLog(prefix?: string) {
    const prefixTag = prefix ? ` [${prefix}]` : '';
    return (message: string) => {
        try {
            appendFileSync(daemonLogPath, `[${getNowInIsoString()}]${prefixTag} ${message}\n`);
        } catch {
            /* swallow log errors so they never crash the daemon */
        }
    };
}
