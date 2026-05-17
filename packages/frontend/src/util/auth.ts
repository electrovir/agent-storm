const storageKey = 'agent-storm-auth-secret';

type Listener = (secret: string | undefined) => void;
const listeners = new Set<Listener>();

export function getStoredSecret(): string | undefined {
    return globalThis.localStorage?.getItem(storageKey) || undefined;
}

export function setStoredSecret(secret: string): void {
    globalThis.localStorage?.setItem(storageKey, secret);
    listeners.forEach((fn) => fn(secret));
}

export function clearStoredSecret(): void {
    globalThis.localStorage?.removeItem(storageKey);
    listeners.forEach((fn) => fn(undefined));
}

export function subscribeSecret(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
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
