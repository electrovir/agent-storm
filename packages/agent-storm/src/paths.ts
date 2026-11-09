import {homedir} from 'node:os';
import {join, resolve, sep} from 'node:path';

/**
 * Same as `path.resolve`, but expands a leading `~` to the home directory the way a shell would.
 *
 * @category Util
 */
export function normalizePath(path: string): string {
    const expanded =
        path === '~'
            ? homedir()
            : path.startsWith('~/') || path.startsWith(`~${sep}`)
              ? join(homedir(), path.slice(2))
              : path;
    return resolve(expanded);
}

/**
 * Whether a failed `node:fs` call failed for the given reason, such as `ENOENT`.
 *
 * @category Util
 */
export function hasErrorCode(error: unknown, code: string) {
    return error instanceof Error && 'code' in error && error.code === code;
}
