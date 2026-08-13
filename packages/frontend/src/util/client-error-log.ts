import {reportClientError} from './api-client.js';

/**
 * Errors already sent, keyed by message + stack. A render error repeats on every re-render (and a
 * broken pane re-renders on every poll), so without this the log fills with thousands of copies of
 * one crash.
 */
const reported = new Set<string>();

/** Ceiling on distinct errors per page load, so a pathological loop can't hammer the backend. */
const maxReportedErrors = 50;

function send({
    error,
    source,
}: Readonly<{
    error: unknown;
    source: string;
}>): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const key = `${source}\n${message}\n${stack || ''}`;
    if (reported.has(key) || reported.size >= maxReportedErrors) {
        return;
    }
    reported.add(key);
    void reportClientError({
        message,
        stack,
        source,
        pageUrl: globalThis.location.href,
    }).catch(() => {
        /* the backend is the thing that logs failures; a failed report has nowhere left to go */
    });
}

/** Passed as every element's `errorHandler` so render failures reach the backend log. */
export function reportRenderError(error: Error): void {
    send({
        error,
        /**
         * Element-vir already prefixes the message with `Failed to render <tag-name>`, so the tag
         * is in the log without having to thread it through here.
         */
        source: 'render',
    });
}

/**
 * Ship uncaught browser errors to the backend, where they land in a log file.
 *
 * The app is used as an installed PWA, which exposes no devtools console, so an error that only
 * reaches `console.error` is effectively invisible. Call once, as early as possible.
 */
export function installClientErrorLog(): void {
    globalThis.addEventListener('error', (event) => {
        send({
            error: event.error ?? event.message,
            source: 'uncaught',
        });
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
        send({
            error: event.reason,
            source: 'unhandledRejection',
        });
    });
}
