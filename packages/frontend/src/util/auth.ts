import {localStorageClient} from './local-storage-client.js';

const setting = localStorageClient.authSecret;

export function getStoredSecret(): string | undefined {
    return setting.read();
}

export function setStoredSecret(secret: string): void {
    setting.write(secret);
}

export function clearStoredSecret(): void {
    setting.clear();
}

export function subscribeSecret(fn: (secret: string | undefined) => void): () => void {
    return setting.subscribe(fn);
}

/**
 * Resolves with the stored secret. If none is stored yet, waits until one is set by the auth modal
 * (or any other caller of `setStoredSecret`). On a 401, `clearStoredSecret` resets the state and
 * the next `ensureSecret` call blocks until the user re-enters via the modal.
 */
export async function ensureSecret(): Promise<string> {
    const existing = getStoredSecret();
    if (existing) {
        return existing;
    }
    return await new Promise<string>((resolve) => {
        const unsubscribe = subscribeSecret((secret) => {
            if (secret) {
                unsubscribe();
                resolve(secret);
            }
        });
    });
}
