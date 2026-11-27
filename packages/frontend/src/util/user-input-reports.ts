import {userInputEndpoint} from '@agent-storm/common';
import {fetchApi} from '@agent-storm/core/frontend';
import {HttpMethod} from '@rest-vir/api';
import {type AnyDuration} from 'date-vir';

/** The server only needs to know the user is around, not see every keystroke. */
const reportInterval = {
    milliseconds: 60_000,
} as const satisfies AnyDuration;

const userInputEvents = [
    'pointerdown',
    'keydown',
    'wheel',
    'touchstart',
] as const;

/**
 * Tells the server, throttled, whenever the user touches the app, so the server knows when they're
 * away.
 */
export function startUserInputReports() {
    const reports = {
        lastAt: 0,
    };
    async function report(event: Event) {
        /** Untrusted events come from scripts, not the user. */
        if (!event.isTrusted || Date.now() - reports.lastAt < reportInterval.milliseconds) {
            return;
        }
        reports.lastAt = Date.now();
        try {
            await fetchApi(userInputEndpoint, HttpMethod.Post);
        } catch {
            reports.lastAt = 0;
        }
    }
    userInputEvents.forEach((eventName) => {
        globalThis.addEventListener(eventName, report, {
            capture: true,
            passive: true,
        });
    });
}
