import {homedir} from 'node:os';
import {join, resolve} from 'node:path';

export function normalizePath(path: string): string {
    const expanded =
        path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
    return resolve(expanded);
}
