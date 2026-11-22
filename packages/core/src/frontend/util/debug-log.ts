import {clientDebugLogEndpoint} from '@agent-storm/common';
import {randomString} from '@augment-vir/common';
import {HttpMethod} from '@rest-vir/api';
import {convertDuration, getNowInUtcTimezone, toUtcIsoString} from 'date-vir';
import {fetchApi} from './api-client.js';

const windowId = randomString(8);

/** Mutated in place: entries collect here between sends. */
const pending: {
    entries: Array<{
        at: string;
        event: string;
        details: unknown;
    }>;
    isSendScheduled: boolean;
    /** Follows the `enableDebugLogs` setting. */
    isEnabled: boolean;
} = {
    entries: [],
    isSendScheduled: false,
    isEnabled: false,
};

/** Turns {@link logDebug} on or off, for the `enableDebugLogs` setting. */
export function setDebugLogEnabled(isEnabled: boolean) {
    pending.isEnabled = isEnabled;
}

/** Whether the `enableDebugLogs` setting is on. */
export function isDebugLogEnabled() {
    return pending.isEnabled;
}

/**
 * Appends an entry to the server's debug log (`debugLogDir`) while the `enableDebugLogs` setting is
 * on, and drops it otherwise. Unlike `reportClientError`, nothing is deduplicated or capped, so it
 * suits code paths that run often. Entries are sent in batches.
 */
export function logDebug(event: string, details: unknown) {
    if (!pending.isEnabled) {
        return;
    }
    pending.entries.push({
        at: toUtcIsoString(getNowInUtcTimezone()),
        event,
        details,
    });
    if (pending.isSendScheduled) {
        return;
    }
    pending.isSendScheduled = true;
    setTimeout(
        () => {
            const entries = pending.entries;
            pending.entries = [];
            pending.isSendScheduled = false;
            void fetchApi(clientDebugLogEndpoint, HttpMethod.Post, {
                requestData: {
                    windowId,
                    pageUrl: globalThis.location.href,
                    entries,
                },
            }).catch(() => {
                /* the backend is where these go; a failed send has nowhere left to go */
            });
        },
        convertDuration(
            {
                milliseconds: 500,
            },
            {
                milliseconds: true,
            },
        ).milliseconds,
    );
}
