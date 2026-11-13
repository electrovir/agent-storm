import {type ClientFreezeRequest} from '@agent-storm/common';
import {convertDuration} from 'date-vir';
import {type FreezeWatchdogPing} from './perf-stats.js';

const frozenMilliseconds = convertDuration(
    {
        seconds: 5,
    },
    {
        milliseconds: true,
    },
).milliseconds;
const repeatReportMilliseconds = convertDuration(
    {
        seconds: 30,
    },
    {
        milliseconds: true,
    },
).milliseconds;
const checkMilliseconds = convertDuration(
    {
        seconds: 1,
    },
    {
        milliseconds: true,
    },
).milliseconds;

const tracking: {
    lastPing: FreezeWatchdogPing | undefined;
    lastPingAt: number;
    lastCheckAt: number;
    /** Set while a reported freeze hasn't ended. */
    lastReportAt: number | undefined;
} = {
    lastPing: undefined,
    lastPingAt: performance.now(),
    lastCheckAt: performance.now(),
    lastReportAt: undefined,
};

function sendReport({
    ping,
    silentMilliseconds,
    isOngoing,
}: Readonly<{
    ping: FreezeWatchdogPing;
    silentMilliseconds: number;
    isOngoing: boolean;
}>) {
    if (!ping.secret) {
        return;
    }
    void fetch(`${ping.backendUrl}/client-freeze`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ping.secret}`,
        },
        body: JSON.stringify({
            ...ping.activity,
            frozenSeconds: Math.round(silentMilliseconds / 1000),
            isOngoing,
        } satisfies ClientFreezeRequest),
    }).catch(() => {
        /* a freeze report that fails to send has nowhere else to go */
    });
}

// eslint-disable-next-line sonarjs/post-message -- a dedicated worker only hears from the page that created it
globalThis.addEventListener('message', (event: MessageEvent<FreezeWatchdogPing>) => {
    const now = performance.now();
    if (tracking.lastReportAt != undefined && tracking.lastPing) {
        sendReport({
            ping: tracking.lastPing,
            silentMilliseconds: now - tracking.lastPingAt,
            isOngoing: false,
        });
    }
    tracking.lastPing = event.data;
    tracking.lastPingAt = now;
    tracking.lastReportAt = undefined;
});

globalThis.setInterval(() => {
    const now = performance.now();
    const sinceLastCheck = now - tracking.lastCheckAt;
    tracking.lastCheckAt = now;
    /**
     * This worker's own timer stalling means the whole app was suspended (the computer slept), so
     * the page's silence over that gap isn't a freeze.
     */
    if (sinceLastCheck >= frozenMilliseconds) {
        tracking.lastPingAt = now;
        return;
    }
    const ping = tracking.lastPing;
    /** A hidden page's timers are throttled, so its pings are expected to stop. */
    if (!ping?.isVisible || now - tracking.lastPingAt < frozenMilliseconds) {
        return;
    }
    if (
        tracking.lastReportAt == undefined ||
        now - tracking.lastReportAt >= repeatReportMilliseconds
    ) {
        tracking.lastReportAt = now;
        sendReport({
            ping,
            silentMilliseconds: now - tracking.lastPingAt,
            isOngoing: true,
        });
    }
}, checkMilliseconds);
