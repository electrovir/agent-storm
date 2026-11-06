import {check} from '@augment-vir/assert';
import {ensureErrorAndPrependMessage, log} from '@augment-vir/common';
import {doesPasswordMatchHash, hashPassword} from 'auth-vir';
import {randomBytes} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {authSecretFileName, authSecretPath, checkoutStateDir} from './file-paths.js';

/**
 * Argon2 encoded hashes always start with `$argon2`. Any other content (e.g. a plain-text key left
 * over from an older version of this server) is treated as missing and replaced.
 */
const argon2Prefix = '$argon2';

const authState: {
    cachedHash: string | undefined;
    watcher: FSWatcher | undefined;
    regenerating: Promise<void> | undefined;
    /** Set while this process writes the secret file, so its own write doesn't trigger a reload. */
    isWritingSelf: boolean;
} = {
    cachedHash: undefined,
    watcher: undefined,
    regenerating: undefined,
    isWritingSelf: false,
};

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
    await mkdir(checkoutStateDir, {
        recursive: true,
    });
    authState.isWritingSelf = true;
    try {
        await writeFile(authSecretPath, hash, {
            mode: 0o600,
        });
    } finally {
        authState.isWritingSelf = false;
    }
    authState.cachedHash = hash;
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

/** Uses the stored hash when there is a valid one, else generates and stores a new secret. */
async function loadOrGenerateSecret(): Promise<void> {
    const existing = await readStoredHash();
    if (existing) {
        authState.cachedHash = existing;
    } else {
        logNewSecret(await generateAndStoreSecret());
    }
}

function handleWatchEvent(filename: string | null): void {
    if (filename !== authSecretFileName || authState.isWritingSelf || authState.regenerating) {
        return;
    }
    authState.regenerating = loadOrGenerateSecret()
        .catch((error: unknown) => {
            log.error(
                ensureErrorAndPrependMessage(error, 'Failed to regenerate auth secret.').message,
            );
        })
        .finally(() => {
            authState.regenerating = undefined;
        });
}

export async function initAuth(): Promise<void> {
    await mkdir(checkoutStateDir, {
        recursive: true,
    });
    await loadOrGenerateSecret();
    authState.watcher?.close();
    authState.watcher = watch(checkoutStateDir, (_eventType, filename) => {
        handleWatchEvent(filename);
    });
}

export async function verifyAuthToken(provided: string | undefined): Promise<boolean> {
    if (!provided || !authState.cachedHash) {
        return false;
    }
    return await doesPasswordMatchHash({
        password: provided,
        hash: authState.cachedHash,
    });
}

/**
 * The token from an `Authorization: Bearer <token>` header. The scheme matches case-insensitively,
 * as RFC 9110 requires. Undefined for any other scheme, a repeated header, or an empty token.
 */
export function extractBearerToken(header: string | string[] | undefined) {
    if (!check.isString(header)) {
        return undefined;
    }
    const trimmed = header.trim();
    const schemePrefix = 'bearer ';
    if (trimmed.slice(0, schemePrefix.length).toLowerCase() !== schemePrefix) {
        return undefined;
    }
    return trimmed.slice(schemePrefix.length).trimStart() || undefined;
}
