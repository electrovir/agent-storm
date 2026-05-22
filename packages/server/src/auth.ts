import {ensureErrorAndPrependMessage, log} from '@augment-vir/common';
import {doesPasswordMatchHash, hashPassword} from 'auth-vir';
import {randomBytes} from 'node:crypto';
import {watch, type FSWatcher} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {authSecretFileName, authSecretPath, notCommittedDir} from './file-paths.js';

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
    if (!provided || !cachedHash) {
        return false;
    }
    return await doesPasswordMatchHash({
        password: provided,
        hash: cachedHash,
    });
}
