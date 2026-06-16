import {getBackendBaseUrl} from './service-origin.js';

/**
 * How many consecutive transport-level failures count as "the backend really went away" instead of
 * a transient blip. With the frontend polling /folders every 2 s, a threshold of 2 means we declare
 * the backend "down" after ~4 s of failed connect attempts — short enough to catch a `tsx --watch`
 * restart (typically ~2-3 s) when the timing lines up, generous enough to ignore a one-off poll
 * dropout caused by network noise.
 */
const downThreshold = 2;

/**
 * Interval between explicit recovery probes once we've decided the backend is down. Faster than the
 * regular poll so the user spends less time staring at a stale UI after the backend comes back.
 */
const probeIntervalMs = 1000;

const state: {
    consecutiveFailures: number;
    declaredDown: boolean;
    reloading: boolean;
} = {
    consecutiveFailures: 0,
    declaredDown: false,
    reloading: false,
};

/**
 * Trigger a full page reload exactly once. Guarded by `reloading` so concurrent probes / API calls
 * that all observe the recovery moment don't each call `window.location.reload()` and pile up.
 */
function reloadOnce(): void {
    if (state.reloading) {
        return;
    }
    state.reloading = true;
    window.location.reload();
}

export function notifyBackendSuccess(): void {
    if (state.declaredDown) {
        /**
         * We previously confirmed the backend was gone and now we got a successful response —
         * that's a restart. Reload the whole window so every in-memory state (auth, route,
         * WebSocket connections, pane attachments, VS Code iframes) is rebuilt against the fresh
         * backend.
         */
        reloadOnce();
        return;
    }
    state.consecutiveFailures = 0;
}

export function notifyBackendFailure(): void {
    if (state.reloading) {
        return;
    }
    state.consecutiveFailures += 1;
    if (!state.declaredDown && state.consecutiveFailures >= downThreshold) {
        state.declaredDown = true;
        scheduleProbe();
    }
}

function scheduleProbe(): void {
    if (state.reloading) {
        return;
    }
    setTimeout(() => {
        void probeAndReload();
    }, probeIntervalMs);
}

async function probeAndReload(): Promise<void> {
    if (state.reloading) {
        return;
    } else if (await isBackendReachable()) {
        reloadOnce();
        return;
    }
    scheduleProbe();
}

/**
 * Any HTTP response — even 401 from a missing auth header — means the backend process is alive and
 * serving. We only treat true network failures (DNS/connect refused/timeout, i.e. `fetch` itself
 * throwing) as "still down". This avoids reload loops when the user's secret is stale.
 */
async function isBackendReachable(): Promise<boolean> {
    try {
        const response = await fetch(`${getBackendBaseUrl()}/folders`, {
            method: 'GET',
            cache: 'no-store',
        });
        return response.status > 0;
    } catch {
        return false;
    }
}
