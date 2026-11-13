import {
    pluginCallEndpoint,
    pluginEventsWebSocket,
    type AnyPluginApiDefinition,
    type PluginCallRequest,
    type PluginCallResponse,
    type PluginEventData,
} from '@agent-storm/common';
import {extractErrorMessage, log, wait} from '@augment-vir/common';
import {HttpMethod, type ClientWebSocket} from '@rest-vir/api';
import {assertValidShape, checkValidShape} from 'object-shape-tester';
import {client, fetchApi} from './api-client.js';
import {ensureSecret} from './auth.js';

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
} = {
    listeners: [],
    socket: undefined,
    reconnectListeners: [],
    hasConnected: false,
};

async function connectPluginEvents(): Promise<PluginEventsSocket | undefined> {
    try {
        const socket = await client.connectWebSocket(pluginEventsWebSocket, {
            protocols: [
                await ensureSecret(),
            ],
            listeners: {
                message({message}) {
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
                    pluginEvents.socket = undefined;
                    await reconnectPluginEvents();
                },
            },
        });
        if (pluginEvents.hasConnected) {
            pluginEvents.reconnectListeners.forEach((listener) => listener());
        }
        pluginEvents.hasConnected = true;
        return socket;
    } catch (error) {
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
            const result = await fetchApi(pluginCallEndpoint, HttpMethod.Post, {
                requestData: {
                    pluginId: api.pluginId,
                    call,
                    request,
                },
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
                    if (checkValidShape(data, api.events[event])) {
                        callback(data);
                    } else {
                        log.warning(`Dropped a malformed '${event}' event from '${api.pluginId}'.`);
                    }
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
