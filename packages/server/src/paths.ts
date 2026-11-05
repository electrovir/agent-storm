import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export function normalizePath(path: string): string {
    const expanded =
        path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    return resolve(expanded);
}

/** Whether a failed `node:fs` call failed for the given reason, such as `ENOENT`. */
export function hasErrorCode(error: unknown, code: string) {
    return error instanceof Error && 'code' in error && error.code === code;
}
