/**
 * Shows the server's push notifications and opens the app at a notification's route when one is
 * clicked. Plain JavaScript so it's served as is, from the same path, by vite and by a release.
 */

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    const notification = event.data ? event.data.json() : {};
    const paths = Array.isArray(notification.paths) ? notification.paths : [];
    event.waitUntil(
        self.registration.showNotification(notification.title || 'agent-storm', {
            body: notification.body || '',
            icon: '/web-app-manifest-192x192.png',
            /** One notification per route: a newer one about the same thread replaces the older. */
            tag: paths.length ? JSON.stringify(paths) : notification.id,
            renotify: true,
            requireInteraction: !!notification.isPersistent,
            data: {
                paths,
            },
        }),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(openApp(event.notification.data?.paths || []));
});

/** Navigates an open window when there is one, since a second window would load the app again. */
async function openApp(paths) {
    const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
    });
    const existing = windows.find((client) => client.focused) || windows[0];
    if (existing) {
        await existing.focus();
        existing.postMessage({
            paths,
        });
        return;
    }
    await self.clients.openWindow(`/${paths.map(encodeURIComponent).join('/')}`);
}
