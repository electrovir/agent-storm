import {
    pluginCallEndpoint,
    pluginEventsHeartbeatInterval,
    pluginEventsWebSocket,
    type AnyPluginApiDefinition,
    type PluginCallRequest,
    type PluginCallResponse,
    type PluginEventData,
} from '@agent-storm/common';
import {extractErrorMessage, log, wait} from '@augment-vir/common';
import {HttpMethod, type ClientWebSocket} from '@rest-vir/api';
import {type AnyDuration} from 'date-vir';
import {assertValidShape} from 'object-shape-tester';
import {client, fetchApi} from './api-client.js';
import {ensureSecret} from './auth.js';
import {reportClientError} from './client-error-log.js';
import {logRequestTiming} from './debug-log.js';

type PluginEventListener = Readonly<{
    pluginId: string;
    event: string;
    callback(data: unknown): void;
}>;

type PluginEventsSocket = ClientWebSocket<typeof pluginEventsWebSocket>;

/** The one events socket every plugin's listeners share, open only while any listener is. */
const pluginEvents: {
    listeners: ReadonlyArray<PluginEventListener>;
    socket: Promise<PluginEventsSocket | undefined> | undefined;
    /** Run each time the socket opens again after having been closed. */
    reconnectListeners: ReadonlyArray<() => void>;
    hasConnected: boolean;
    /** Counts connection attempts, so a replaced socket's late messages and close are ignored. */
    connectionCount: number;
    /** `Date.now()` of the current socket's last message, or of its connection attempt. */
    lastMessageAt: number;
    hasSilenceCheck: boolean;
} = {
    listeners: [],
    socket: undefined,
    reconnectListeners: [],
    hasConnected: false,
    connectionCount: 0,
    lastMessageAt: 0,
    hasSilenceCheck: false,
};

/** Several missed server heartbeats in a row. */
const silentSocketLimit = {
    milliseconds: pluginEventsHeartbeatInterval.milliseconds * 3,
} as const satisfies AnyDuration;

async function connectPluginEvents(): Promise<PluginEventsSocket | undefined> {
    pluginEvents.connectionCount += 1;
    const connection = pluginEvents.connectionCount;
    pluginEvents.lastMessageAt = Date.now();
    startSilenceCheck();
    function isCurrent() {
        return connection === pluginEvents.connectionCount;
    }
    try {
        const socket = await client.connectWebSocket(pluginEventsWebSocket, {
            protocols: [
                await ensureSecret(),
            ],
            listeners: {
                message({message}) {
                    if (!isCurrent()) {
                        return;
                    }
                    pluginEvents.lastMessageAt = Date.now();
                    pluginEvents.listeners
                        .filter((listener) => {
                            return (
                                listener.pluginId === message.pluginId &&
                                listener.event === message.event
                            );
                        })
                        .forEach((listener) => listener.callback(message.data));
                },
                async close() {
                    if (!isCurrent()) {
                        return;
                    }
                    pluginEvents.socket = undefined;
                    await reconnectPluginEvents();
                },
            },
        });
        if (!isCurrent()) {
            await socket.close();
            return undefined;
        }
        if (pluginEvents.hasConnected) {
            pluginEvents.reconnectListeners.forEach((listener) => listener());
        }
        pluginEvents.hasConnected = true;
        return socket;
    } catch (error) {
        if (!isCurrent()) {
            return undefined;
        }
        log.warning(`Can't open the plugin events socket: ${extractErrorMessage(error)}`);
        pluginEvents.socket = undefined;
        await reconnectPluginEvents();
        return undefined;
    }
}

async function reconnectPluginEvents() {
    await wait({
        seconds: 2,
    });
    if (pluginEvents.listeners.length && !pluginEvents.socket) {
        pluginEvents.socket = connectPluginEvents();
    }
}

/**
 * A socket the network drops without a closing handshake can go a long time without firing `close`,
 * and until it does the page gets no events and never reconnects. The server's heartbeat keeps a
 * working socket from going this quiet, so silence means the socket is gone.
 */
function startSilenceCheck() {
    if (pluginEvents.hasSilenceCheck) {
        return;
    }
    pluginEvents.hasSilenceCheck = true;
    setInterval(() => {
        void replaceSilentSocket();
    }, pluginEventsHeartbeatInterval.milliseconds);
}

async function replaceSilentSocket() {
    const silentSocket = pluginEvents.socket;
    if (!silentSocket || Date.now() - pluginEvents.lastMessageAt < silentSocketLimit.milliseconds) {
        return;
    }
    log.warning('The plugin events socket went silent. Reconnecting.');
    pluginEvents.socket = connectPluginEvents();
    await (await silentSocket)?.close();
}

async function addPluginEventListener(listener: PluginEventListener) {
    pluginEvents.listeners = [
        ...pluginEvents.listeners,
        listener,
    ];
    pluginEvents.socket ||= connectPluginEvents();
    await pluginEvents.socket;
}

async function removePluginEventListener(listener: PluginEventListener) {
    pluginEvents.listeners = pluginEvents.listeners.filter((entry) => entry !== listener);
    if (!pluginEvents.listeners.length) {
        const socket = await pluginEvents.socket;
        pluginEvents.socket = undefined;
        await socket?.close();
    }
}

/**
 * The browser side of a plugin's API: calls into its server part, and listens to the events it
 * sends. Both check what arrives against the API's shapes.
 */
export function createPluginApiClient<const Api extends AnyPluginApiDefinition>(api: Api) {
    return {
        async call<const Call extends keyof Api['calls'] & string>(
            call: Call,
            request: PluginCallRequest<Api, Call>,
        ): Promise<PluginCallResponse<Api, Call>> {
            const startedAt = performance.now();
            const result = await fetchApi(pluginCallEndpoint, HttpMethod.Post, {
                requestData: {
                    pluginId: api.pluginId,
                    call,
                    request,
                },
            }).finally(() => {
                logRequestTiming({
                    name: `${api.pluginId}.${call}`,
                    startedAt,
                });
            });
            if ('errorMessage' in result) {
                throw new Error(result.errorMessage);
            }
            assertValidShape(result.response, api.calls[call].responseShape);
            return result.response;
        },
        /**
         * Runs `callback` with each `event` the plugin's server part sends until the returned
         * remover is called. Events sent while the socket reconnects are missed.
         */
        listen<const Event extends keyof Api['events'] & string>(
            event: Event,
            callback: (data: PluginEventData<Api, Event>) => void,
        ) {
            const listener: PluginEventListener = {
                pluginId: api.pluginId,
                event,
                callback(data) {
                    try {
                        assertValidShape(data, api.events[event]);
                    } catch (error) {
                        const message = `Dropped a malformed '${event}' event from '${api.pluginId}': ${extractErrorMessage(error)}`;
                        log.warning(message);
                        reportClientError({
                            error: new Error(message),
                            source: 'plugin events',
                        });
                        return;
                    }
                    callback(data);
                },
            };
            void addPluginEventListener(listener);
            return async () => {
                await removePluginEventListener(listener);
            };
        },
        /**
         * Runs `callback` each time the events socket opens again after closing, so a caller can
         * re-read whatever the events it missed meanwhile would have changed. Doesn't keep the
         * socket open by itself.
         */
        listenToReconnect(callback: () => void) {
            pluginEvents.reconnectListeners = [
                ...pluginEvents.reconnectListeners,
                callback,
            ];
            return () => {
                pluginEvents.reconnectListeners = pluginEvents.reconnectListeners.filter(
                    (entry) => entry !== callback,
                );
            };
        },
    };
}
