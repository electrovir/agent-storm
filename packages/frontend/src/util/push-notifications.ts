import {
    pushKeyEndpoint,
    pushSubscribeEndpoint,
    pushTestEndpoint,
    pushUnsubscribeEndpoint,
} from '@agent-storm/common';
import {fetchApi} from '@agent-storm/core/frontend';
import {assertWrap, check} from '@augment-vir/assert';
import {HttpMethod} from '@rest-vir/api';

/** Whether this device gets push notifications, or why it can't. */
export enum PushStatus {
    /** Browsers only allow push on https or localhost. */
    Insecure = 'insecure',
    Unsupported = 'unsupported',
    /** The user blocked notifications for this site in the browser or OS settings. */
    Denied = 'denied',
    Off = 'off',
    On = 'on',
}

const serviceWorkerPath = '/service-worker.js';

function hasPushApis() {
    return (
        'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis
    );
}

async function readSubscription() {
    const registration = await navigator.serviceWorker.getRegistration(serviceWorkerPath);
    return (await registration?.pushManager.getSubscription()) || undefined;
}

async function saveSubscription(subscription: Readonly<PushSubscription>) {
    const {endpoint, keys} = subscription.toJSON();
    await fetchApi(pushSubscribeEndpoint, HttpMethod.Post, {
        requestData: {
            endpoint: assertWrap.isDefined(endpoint),
            p256dh: assertWrap.isDefined(keys?.p256dh),
            auth: assertWrap.isDefined(keys?.auth),
        },
    });
}

/** The VAPID public key's URL-safe base64, as the bytes `PushManager.subscribe` takes. */
function decodeVapidKey(publicKey: string) {
    const base64 = publicKey.replaceAll('-', '+').replaceAll('_', '/');
    return Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')),
        (character) => {
            return character.codePointAt(0) ?? 0;
        },
    );
}

export async function readPushStatus() {
    if (!globalThis.isSecureContext) {
        return PushStatus.Insecure;
    } else if (!hasPushApis()) {
        return PushStatus.Unsupported;
    } else if (Notification.permission === 'denied') {
        return PushStatus.Denied;
    } else {
        return Notification.permission === 'granted' && (await readSubscription())
            ? PushStatus.On
            : PushStatus.Off;
    }
}

/**
 * Asks for permission and subscribes this device. Call it from a click: iOS only shows the
 * permission prompt for one.
 */
export async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        return await readPushStatus();
    }
    await navigator.serviceWorker.register(serviceWorkerPath, {
        scope: '/',
    });
    const registration = await navigator.serviceWorker.ready;
    const {publicKey} = await fetchApi(pushKeyEndpoint, HttpMethod.Get);
    /** A subscription made with another server's key can't be reused, so start fresh. */
    await (await registration.pushManager.getSubscription())?.unsubscribe();
    await saveSubscription(
        await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: decodeVapidKey(publicKey),
        }),
    );
    return await readPushStatus();
}

export async function disablePush() {
    const subscription = await readSubscription();
    if (subscription) {
        await fetchApi(pushUnsubscribeEndpoint, HttpMethod.Post, {
            requestData: {
                endpoint: subscription.endpoint,
            },
        });
        await subscription.unsubscribe();
    }
    return await readPushStatus();
}

/** Resolves to an error message, empty once the push service accepted the test. */
export async function sendTestPush() {
    const subscription = await readSubscription();
    if (!subscription) {
        return 'Push notifications are off on this device.';
    }
    return (
        await fetchApi(pushTestEndpoint, HttpMethod.Post, {
            requestData: {
                endpoint: subscription.endpoint,
            },
        })
    ).errorMessage;
}

/** Closes this device's shown push notifications that open `paths`. */
export async function closePushNotifications(paths: ReadonlyArray<string>) {
    if (!globalThis.isSecureContext || !hasPushApis()) {
        return;
    }
    const registration = await navigator.serviceWorker.getRegistration(serviceWorkerPath);
    (await registration?.getNotifications())
        ?.filter((notification) => {
            return (
                check.isObject(notification.data) &&
                check.jsonEquals(notification.data.paths, paths)
            );
        })
        .forEach((notification) => notification.close());
}

/**
 * Hands this device's subscription to the server again, which forgets one the push service
 * rejected, and opens the app at the route a clicked notification asks for. Returns a function that
 * stops listening for those clicks.
 */
export function startPushNotifications(navigate: (paths: ReadonlyArray<string>) => void) {
    if (!globalThis.isSecureContext || !hasPushApis()) {
        return () => {};
    }
    function navigateOnClick(event: MessageEvent<unknown>) {
        const data: unknown = event.data;
        if (
            check.isObject(data) &&
            'paths' in data &&
            check.isArray(data.paths) &&
            data.paths.every((path) => check.isString(path))
        ) {
            navigate(data.paths);
        }
    }
    navigator.serviceWorker.addEventListener('message', navigateOnClick);
    navigator.serviceWorker.startMessages();
    void readSubscription().then(async (subscription) => {
        if (subscription && Notification.permission === 'granted') {
            await saveSubscription(subscription);
        }
    });
    return () => {
        navigator.serviceWorker.removeEventListener('message', navigateOnClick);
    };
}
