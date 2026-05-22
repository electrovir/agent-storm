import {agentStormService} from '@agent-storm/common';

/**
 * How many consecutive API failures count as "the backend is gone" rather than a transient blip. At
 * {@link probeIntervalMs} between checks, the user sees no reaction to brief hiccups (single dropped
 * poll) but reliably enters recovery within ~10 seconds when the backend actually dies — long
 * enough for tsx --watch to finish a restart cycle.
 */
const failureThreshold = 5;

/** Interval between recovery-probe attempts once we've decided the backend is down. */
const probeIntervalMs = 2000;

const state: {
    consecutiveFailures: number;
    recovering: boolean;
} = {
    consecutiveFailures: 0,
    recovering: false,
};

export function notifyBackendSuccess(): void {
    state.consecutiveFailures = 0;
}

export function notifyBackendFailure(): void {
    if (state.recovering) {
        return;
    }
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= failureThreshold) {
        startRecovery();
    }
}

function startRecovery(): void {
    state.recovering = true;
    scheduleProbe();
}

function scheduleProbe(): void {
    setTimeout(() => {
        void probeAndReload();
    }, probeIntervalMs);
}

async function probeAndReload(): Promise<void> {
    if (await isBackendReachable()) {
        window.location.reload();
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
        const response = await fetch(`${agentStormService.serviceOrigin}/folders`, {
            method: 'GET',
            cache: 'no-store',
        });
        return response.status > 0;
    } catch {
        return false;
    }
}
