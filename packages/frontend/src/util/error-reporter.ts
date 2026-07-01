import {clientErrorEndpoint} from '@agent-storm/common';
import {ensureSecret} from './auth.js';
import {getBackendBaseUrl} from './service-origin.js';

/**
 * Sends a frontend error to the backend's `.logs/frontend-errors.log`. Best-effort: never throws
 * back into the page if the server is unreachable or auth hasn't been set up yet. Use this from
 * code paths that want explicit, intentional reporting; nothing global wraps `console.error` or
 * any other built-in.
 *
 * `installErrorReporter()` attaches `window.error` and `unhandledrejection` listeners so unhandled
 * failures still reach the server without needing every caller to wrap their code in try/catch.
 */

type ReportPayload = Readonly<{
    message: string;
    stack: string | null;
    source: string;
}>;

function describe(value: unknown): {message: string; stack: string | null} {
    if (value instanceof Error) {
        return {message: value.message || value.name, stack: value.stack ?? null};
    }
    if (typeof value === 'string') {
        return {message: value, stack: null};
    }
    try {
        return {message: JSON.stringify(value), stack: null};
    } catch {
        return {message: String(value), stack: null};
    }
}

function send(payload: ReportPayload): void {
    void (async () => {
        try {
            const secret = await ensureSecret();
            await fetch(`${getBackendBaseUrl()}${clientErrorEndpoint.path}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${secret}`,
                },
                /**
                 * `keepalive` lets the POST survive a page unload (e.g. when the failure is the
                 * user navigating away).
                 */
                keepalive: true,
                body: JSON.stringify({
                    message: payload.message,
                    stack: payload.stack,
                    source: payload.source,
                    url: globalThis.location?.href ?? null,
                    userAgent: globalThis.navigator?.userAgent ?? null,
                }),
            });
        } catch {
            /* reporting must never cascade into another error */
        }
    })();
}

let installed = false;

export function installErrorReporter(): void {
    if (installed) {
        return;
    }
    installed = true;

    globalThis.addEventListener('error', (event) => {
        const {message, stack} = describe(event.error ?? event.message);
        send({message, stack, source: 'window.onerror'});
    });

    globalThis.addEventListener('unhandledrejection', (event) => {
        const {message, stack} = describe(event.reason);
        send({message, stack, source: 'unhandledrejection'});
    });
}

export function reportClientError(error: unknown, source = 'manual'): void {
    const {message, stack} = describe(error);
    send({message, stack, source});
}
