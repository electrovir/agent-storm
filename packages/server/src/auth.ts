import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The repo root, resolved relative to this file (which lives at packages/server/src/auth.ts).
 * `.not-committed` is git-ignored at the repo root.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const secretPath = resolve(repoRoot, '.not-committed', 'auth-secret');

let cachedSecret: string | undefined;

export async function ensureAuthSecret(): Promise<string> {
    if (cachedSecret) {
        return cachedSecret;
    }
    const existing = await readFile(secretPath, 'utf-8')
        .then((contents) => contents.trim())
        .catch(() => undefined);
    if (existing) {
        cachedSecret = existing;
        return existing;
    }
    const fresh = randomBytes(32).toString('hex');
    await mkdir(dirname(secretPath), {recursive: true});
    await writeFile(secretPath, fresh, {mode: 0o600});
    cachedSecret = fresh;
    return fresh;
}

export function getAuthSecret(): string {
    if (!cachedSecret) {
        throw new Error('Auth secret has not been initialized. Call ensureAuthSecret() first.');
    }
    return cachedSecret;
}
