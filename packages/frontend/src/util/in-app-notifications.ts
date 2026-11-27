import {notificationsWebSocket, type AppNotification} from '@agent-storm/common';
import {client, ensureSecret} from '@agent-storm/core/frontend';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, log, wait} from '@augment-vir/common';
import {type ClientWebSocket} from '@rest-vir/api';
import {router} from './router.js';

function isWindowActive() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Listens for the server's notifications while the app is open, and tells the server whether the
 * user is looking at this window and which route it shows. Reconnects when the socket closes.
 * `onRouteSeen` gets the route each time the user is seen looking at it, so notifications that
 * point there can go away.
 */
export function startInAppNotifications({
    onNotification,
    onDismissed,
    onRouteSeen,
}: Readonly<{
    onNotification: (notification: AppNotification) => void;
    /** Gets the toasts the user dismissed in another window. */
    onDismissed: (dismissedIds: ReadonlyArray<string>) => void;
    onRouteSeen: (paths: ReadonlyArray<string>) => void;
}>) {
    const connection: {
        socket: ClientWebSocket<typeof notificationsWebSocket> | undefined;
        isStopped: boolean;
        isReconnecting: boolean;
    } = {
        socket: undefined,
        isStopped: false,
        isReconnecting: false,
    };

    function sendWindowState() {
        const isActive = isWindowActive();
        const paths = [
            ...router.readCurrentRoute().paths,
        ];
        connection.socket?.send({
            isActive,
            paths,
        });
        if (isActive) {
            onRouteSeen(paths);
        }
    }

    async function connect() {
        try {
            connection.socket = await client.connectWebSocket(notificationsWebSocket, {
                protocols: [
                    await ensureSecret(),
                ],
                listeners: {
                    message({message}) {
                        if ('dismissedIds' in message) {
                            onDismissed(message.dismissedIds);
                        } else {
                            onNotification(message);
                            /**
                             * The server skips a new notification for the route the user is looking
                             * at, but a saved one it replays on connect can still land on that
                             * route.
                             */
                            const paths = router.readCurrentRoute().paths;
                            if (isWindowActive() && check.jsonEquals(paths, message.paths)) {
                                onRouteSeen(paths);
                            }
                        }
                    },
                    async close() {
                        connection.socket = undefined;
                        await reconnect();
                    },
                },
            });
            if (connection.isStopped) {
                await connection.socket.close();
                return;
            }
            sendWindowState();
        } catch (error) {
            log.warning(`Can't open the notifications socket: ${extractErrorMessage(error)}`);
            await reconnect();
        }
    }

    async function reconnect() {
        /**
         * A failed connect both fires the socket's `close` listener and rejects, and each calls
         * this. Without the guard every failure doubles the retry loops, and each loop opens its
         * own socket once the server is back, so every notification shows once per socket.
         */
        if (connection.isReconnecting) {
            return;
        }
        connection.isReconnecting = true;
        await wait({
            seconds: 2,
        });
        connection.isReconnecting = false;
        if (!connection.isStopped && !connection.socket) {
            await connect();
        }
    }

    document.addEventListener('visibilitychange', sendWindowState);
    globalThis.addEventListener('focus', sendWindowState);
    globalThis.addEventListener('blur', sendWindowState);
    const stopRouteListener = router.listen(false, sendWindowState);
    void connect();

    return {
        stop() {
            connection.isStopped = true;
            document.removeEventListener('visibilitychange', sendWindowState);
            globalThis.removeEventListener('focus', sendWindowState);
            globalThis.removeEventListener('blur', sendWindowState);
            stopRouteListener();
            void connection.socket?.close();
        },
        /** Tells every other window to drop the toasts with `dismissedIds`. */
        sendDismissed(dismissedIds: ReadonlyArray<string>) {
            if (dismissedIds.length) {
                connection.socket?.send({
                    dismissedIds: [...dismissedIds],
                });
            }
        },
    };
}
