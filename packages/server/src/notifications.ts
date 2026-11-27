import {
    isNotificationEnabled,
    NotificationDelivery,
    type AppNotification,
    type notificationsWebSocket,
    type notificationWindowStateShape,
    type NotifyParams,
} from '@agent-storm/common';
import {check} from '@augment-vir/assert';
import {extractErrorMessage, HttpStatus, log, mapEnumToObject} from '@augment-vir/common';
import {readFileIfExists} from '@augment-vir/node';
import {type WebSocketHostMessageType} from '@rest-vir/api';
import {normalizePath, writeFileAtomically} from 'agent-storm-util';
import {convertDuration} from 'date-vir';
import {randomUUID} from 'node:crypto';
import {defineShape, parseJsonWithShape} from 'object-shape-tester';
import {generateVAPIDKeys, sendNotification as sendWebPush, WebPushError} from 'web-push';
import {loadAppState, updateAppState} from './app-state.js';
import {vapidKeysPath} from './file-paths.js';
import {getCachedFolders} from './folder-info.js';
import {loadSettings} from './settings.js';

const vapidKeysShape = defineShape({
    publicKey: '',
    privateKey: '',
});

type PushSubscriptionData = NonNullable<
    Awaited<ReturnType<typeof loadAppState>>['pushSubscriptions']
>[number];

type NotificationSocket = Readonly<{
    send(message: WebSocketHostMessageType<typeof notificationsWebSocket>): void;
}>;

const notificationState: {
    vapidKeys: Promise<typeof vapidKeysShape.runtimeType> | undefined;
    /** Each open window's socket, whether the user is looking at that window, and its route. */
    sockets: ReadonlyMap<
        NotificationSocket,
        Readonly<typeof notificationWindowStateShape.runtimeType>
    >;
} = {
    vapidKeys: undefined,
    sockets: new Map(),
};

async function loadOrCreateVapidKeys() {
    const contents = await readFileIfExists(vapidKeysPath);
    if (contents != undefined) {
        return parseJsonWithShape(contents, vapidKeysShape);
    }
    const keys = generateVAPIDKeys();
    await writeFileAtomically({
        path: vapidKeysPath,
        contents: JSON.stringify(keys, undefined, 4),
        mode: 0o600,
    });
    return keys;
}

/** The server's VAPID keys. Created once and kept, since every subscription is tied to them. */
export async function readVapidKeys() {
    notificationState.vapidKeys ||= loadOrCreateVapidKeys().catch((error: unknown) => {
        notificationState.vapidKeys = undefined;
        throw error;
    });
    return await notificationState.vapidKeys;
}

/** Records whether the user is looking at the window `socket` belongs to, and what it shows. */
export function setNotificationSocket(
    socket: NotificationSocket,
    windowState: Readonly<typeof notificationWindowStateShape.runtimeType>,
) {
    notificationState.sockets = new Map([
        ...notificationState.sockets,
        [
            socket,
            windowState,
        ],
    ]);
}

/** Shows the saved persistent toasts in the window that just connected with `socket`. */
export async function sendSavedNotifications(socket: NotificationSocket) {
    (await loadAppState()).notifications?.forEach((notification) => socket.send(notification));
}

/**
 * Tells every window but `socket`'s to drop the toasts the user dismissed in `socket`'s window, and
 * forgets them so they don't come back after a restart.
 */
export async function sendDismissedNotifications({
    socket,
    dismissedIds,
}: Readonly<{
    socket: NotificationSocket;
    dismissedIds: ReadonlyArray<string>;
}>) {
    [...notificationState.sockets.keys()]
        .filter((entry) => entry !== socket)
        .forEach((entry) => {
            entry.send({
                dismissedIds: [...dismissedIds],
            });
        });
    await updateAppState((state) => {
        return state.notifications?.some((notification) => dismissedIds.includes(notification.id))
            ? {
                  ...state,
                  notifications: state.notifications.filter((notification) => {
                      return !dismissedIds.includes(notification.id);
                  }),
              }
            : undefined;
    });
}

export function removeNotificationSocket(socket: NotificationSocket) {
    notificationState.sockets = new Map(
        [...notificationState.sockets].filter(([entry]) => entry !== socket),
    );
}

/** Saves `subscription`, replacing an earlier one with the same endpoint. */
export async function addPushSubscription(subscription: Readonly<PushSubscriptionData>) {
    await updateAppState((state) => {
        return {
            ...state,
            pushSubscriptions: [
                ...(state.pushSubscriptions || []).filter((entry) => {
                    return entry.endpoint !== subscription.endpoint;
                }),
                subscription,
            ],
        };
    });
}

export async function removePushSubscriptions(endpoints: ReadonlyArray<string>) {
    if (!endpoints.length) {
        return;
    }
    await updateAppState((state) => {
        return {
            ...state,
            pushSubscriptions: (state.pushSubscriptions || []).filter((entry) => {
                return !endpoints.includes(entry.endpoint);
            }),
        };
    });
}

/**
 * Sends `notification` to one device. Resolves to an error message, empty once the device's push
 * service accepted it. A subscription the push service no longer knows is forgotten.
 */
async function pushToSubscription({
    subscription,
    notification,
}: Readonly<{
    subscription: Readonly<PushSubscriptionData>;
    notification: Readonly<AppNotification>;
}>) {
    const vapidKeys = await readVapidKeys();
    try {
        await sendWebPush(
            {
                endpoint: subscription.endpoint,
                keys: {
                    p256dh: subscription.p256dh,
                    auth: subscription.auth,
                },
            },
            JSON.stringify(notification),
            {
                vapidDetails: {
                    subject: 'https://github.com/electrovir/agent-storm',
                    publicKey: vapidKeys.publicKey,
                    privateKey: vapidKeys.privateKey,
                },
                TTL: convertDuration(
                    {
                        hours: 1,
                    },
                    {
                        seconds: true,
                    },
                ).seconds,
                urgency: 'high',
            },
        );
        return '';
    } catch (error) {
        /** Push services answer 404 or 410 for a subscription that expired or was revoked. */
        if (
            error instanceof WebPushError &&
            (error.statusCode === HttpStatus.NotFound || error.statusCode === HttpStatus.Gone)
        ) {
            await removePushSubscriptions([
                subscription.endpoint,
            ]);
            return 'This device is no longer subscribed. Turn push notifications on again.';
        }
        return extractErrorMessage(error);
    }
}

/** Pushes a test notification to the device subscribed with `endpoint`. */
export async function sendTestPush(endpoint: string) {
    const subscription = (await loadAppState()).pushSubscriptions?.find((entry) => {
        return entry.endpoint === endpoint;
    });
    if (!subscription) {
        return 'This device is not subscribed. Turn push notifications on again.';
    }
    return await pushToSubscription({
        subscription,
        notification: {
            id: randomUUID(),
            typeId: '',
            title: 'Agent Storm',
            body: 'Push notifications work on this device.',
            paths: [],
            isPersistent: false,
        },
    });
}

/** The folders whose notification overrides apply to `folder`, nearest first. */
async function findOverrideFolders(folder: string) {
    const path = normalizePath(folder);
    const parentRepoPath = (await getCachedFolders()).find(
        (info) => info.path === path,
    )?.parentRepoPath;
    return parentRepoPath
        ? [
              path,
              parentRepoPath,
          ]
        : [
              path,
          ];
}

/**
 * Shows a notification by each delivery the user's settings turn on for its type and folder. A push
 * is skipped while the user is looking at a window that shows it as a toast. Nothing is shown while
 * the user is looking at a window already on the notification's route.
 */
export async function sendNotification({type, folder, title, body, paths}: NotifyParams) {
    const settings = await loadSettings();
    const isRouteInView = [
        ...notificationState.sockets.values(),
    ].some(
        (windowState) => windowState.isActive && check.jsonEquals(windowState.paths, [...paths]),
    );
    if (settings.muteNotifications || isRouteInView) {
        return;
    }
    const folders = folder ? await findOverrideFolders(folder) : [];
    const isEnabled = mapEnumToObject(NotificationDelivery, (delivery) => {
        return isNotificationEnabled({
            settings,
            type,
            delivery,
            folders,
        });
    });
    const notification: AppNotification = {
        id: randomUUID(),
        typeId: type.id,
        title,
        body,
        paths: [...paths],
        isPersistent: isEnabled[NotificationDelivery.Persistent],
    };
    if (isEnabled[NotificationDelivery.InApp]) {
        [...notificationState.sockets.keys()].forEach((socket) => socket.send(notification));
        /** Mirrors the toasts' own rule: a new toast replaces any toast for the same route. */
        await updateAppState((state) => {
            return {
                ...state,
                notifications: [
                    ...(state.notifications || [])
                        .filter((saved) => !check.jsonEquals(saved.paths, notification.paths))
                        .slice(-4),
                    ...(notification.isPersistent
                        ? [
                              notification,
                          ]
                        : []),
                ],
            };
        });
    }
    const isSeenInApp =
        isEnabled[NotificationDelivery.InApp] &&
        [...notificationState.sockets.values()].some((windowState) => windowState.isActive);
    if (!isEnabled[NotificationDelivery.Push] || isSeenInApp) {
        return;
    }
    const errors = await Promise.all(
        ((await loadAppState()).pushSubscriptions || []).map(async (subscription) => {
            return await pushToSubscription({
                subscription,
                notification,
            });
        }),
    );
    errors
        .filter(Boolean)
        .forEach((message) => log.warning(`A push notification failed: ${message}`));
}
