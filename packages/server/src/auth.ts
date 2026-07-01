import {ensureErrorAndPrependMessage, log} from '@augment-vir/common';
import {doesPasswordMatchHash, hashPassword} from 'auth-vir';
import {randomBytes} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {authSecretFileName, authSecretPath, notCommittedDir} from './file-paths.js';

/**
 * Set by `start.script.ts` when running `--electron`. A 256-bit hex string generated fresh per
 * launch and injected into both the backend (here) and the Electron main process via env. We
 * treat it as the only accepted bearer when present — no on-disk file, no argon2 hashing. The
 * Electron main process forwards the same value to the renderer through the preload so the
 * auth modal never shows.
 *
 * Why this is real auth, not a bypass:
 *   - 256 bits of randomness — unguessable.
 *   - Only the backend, the Electron main process, and the renderer (via preload) ever see it.
 *   - Rotates on every stack restart; nothing persists on disk for an attacker to grab later.
 *   - A LAN attacker hitting `0.0.0.0:41880` still has to present this token.
 *
 * When unset (i.e. `npm start` without `--electron`), the persistent file-backed argon2 flow
 * below runs as before.
 */
const runtimeSecret = process.env.AGENT_STORM_RUNTIME_SECRET || undefined;

/**
 * Argon2 encoded hashes always start with `$argon2`. Any other content (e.g. a plain-text key left
 * over from an older version of this server) is treated as missing and replaced.
 */
const argon2Prefix = '$argon2';

let cachedHash: string | undefined;
let watcher: FSWatcher | undefined;
let regenerating: Promise<void> | undefined;
let writingSelf = false;

async function readStoredHash(): Promise<string | undefined> {
    const contents = await readFile(authSecretPath, 'utf-8').catch(() => undefined);
    if (contents == undefined) {
        return undefined;
    }
    const trimmed = contents.trim();
    if (!trimmed.startsWith(argon2Prefix)) {
        return undefined;
    }
    return trimmed;
}

async function generateAndStoreSecret(): Promise<string> {
    const cleartext = randomBytes(32).toString('hex');
    const hash = await hashPassword(cleartext);
    await mkdir(notCommittedDir, {
        recursive: true,
    });
    writingSelf = true;
    try {
        await writeFile(authSecretPath, hash, {
            mode: 0o600,
        });
    } finally {
        writingSelf = false;
    }
    cachedHash = hash;
    return cleartext;
}

function logNewSecret(cleartext: string): void {
    log.info(
        [
            `auth secret: ${cleartext}`,
            'Save this — only the argon2id hash is stored on disk.',
            `Delete ${authSecretPath} to generate a new key.`,
        ].join('\n'),
    );
}

async function regenerate(): Promise<void> {
    const cleartext = await generateAndStoreSecret();
    logNewSecret(cleartext);
}

function handleWatchEvent(filename: string | null): void {
    if (filename !== authSecretFileName || writingSelf || regenerating) {
        return;
    }
    regenerating = (async () => {
        const existing = await readStoredHash();
        if (existing) {
            cachedHash = existing;
            return;
        }
        await regenerate();
    })()
        .catch((error: unknown) => {
            log.error(
                ensureErrorAndPrependMessage(error, 'Failed to regenerate auth secret.').message,
            );
        })
        .finally(() => {
            regenerating = undefined;
        });
}

export async function initAuth(): Promise<void> {
    if (runtimeSecret) {
        // Logged so a user running `AGENT_STORM_BIND_HOST=0.0.0.0` for LAN testing can copy
        // it into the auth modal on another device. With the default 127.0.0.1 bind this is
        // just a debug breadcrumb — only the renderer (seeded by the Electron preload) ever
        // needs the value at runtime.
        log.info(`auth secret (runtime, this session only): ${runtimeSecret}`);
        return;
    }
    await mkdir(notCommittedDir, {
        recursive: true,
    });
    const existing = await readStoredHash();
    if (existing) {
        cachedHash = existing;
    } else {
        const cleartext = await generateAndStoreSecret();
        logNewSecret(cleartext);
    }
    watcher?.close();
    watcher = watch(notCommittedDir, (_eventType, filename) => {
        handleWatchEvent(filename);
    });
}

export async function verifyAuthToken(provided: string | undefined): Promise<boolean> {
    if (!provided) {
        return false;
    }
    if (runtimeSecret) {
        // Constant-time equality against the runtime secret. Argon2's `doesPasswordMatchHash`
        // would also work but is gratuitous: we're comparing against a known-strong, server-
        // generated 256-bit string, not a user-chosen password, so there's nothing for the
        // KDF to defend against.
        return timingSafeEqual(provided, runtimeSecret);
    }
    if (!cachedHash) {
        return false;
    }
    return await doesPasswordMatchHash({
        password: provided,
        hash: cachedHash,
    });
}

/**
 * Constant-time string comparison. Avoids the early-exit timing channel a plain `===` would
 * expose if an attacker could measure response latency at sub-microsecond resolution.
 */
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}
