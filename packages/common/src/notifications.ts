import {type PartialWithUndefined} from '@augment-vir/common';
import {defineShape} from 'object-shape-tester';
import {type Settings} from './api.js';
import {NotificationDelivery} from './enums.js';

/**
 * Something a plugin can notify the user of. The Settings modal lists each one that a running
 * plugin's `notificationTypes` holds.
 */
export type NotificationType = Readonly<{
    /** Prefixed by the owning plugin's id, so no two plugins' types can collide. */
    id: string;
    pluginId: string;
    label: string;
    description: string;
}> &
    PartialWithUndefined<{
        /** Off until the user turns it on, in-app and by push. */
        isOptIn: boolean;
    }>;

/**
 * Defines one of a plugin's notification types. Its id is `name` prefixed with the plugin's id, so
 * two plugins can use the same name.
 */
export function defineNotificationType({
    name,
    ...type
}: Readonly<
    Omit<NotificationType, 'id'> & {
        name: string;
    }
>): NotificationType {
    return {
        ...type,
        id: `${type.pluginId}:${name}`,
    };
}

/** What a plugin's server part hands `host.notify`. */
export type NotifyParams = Readonly<{
    type: NotificationType;
    title: string;
    body: string;
    /** The route a click on the notification opens, starting with an activity id. */
    paths: ReadonlyArray<string>;
}> &
    PartialWithUndefined<{
        /** The folder the notification is about, whose overrides in Settings then apply. */
        folder: string;
    }>;

/** One notification, as the server sends it to a window or a device. */
export const notificationShape = defineShape({
    /** Unique to this notification. */
    id: '',
    typeId: '',
    title: '',
    body: '',
    paths: [
        '',
    ],
    /** Stays until the user dismisses it instead of hiding on its own. */
    isPersistent: false,
});

export type AppNotification = typeof notificationShape.runtimeType;

const defaultChoices: Readonly<
    Record<NotificationDelivery, (type: Readonly<Pick<NotificationType, 'isOptIn'>>) => boolean>
> = {
    [NotificationDelivery.InApp](type) {
        return !type.isOptIn;
    },
    [NotificationDelivery.Persistent]() {
        return false;
    },
    [NotificationDelivery.Push](type) {
        return !type.isOptIn;
    },
};

/** Whether `delivery` is on for `type` when the user hasn't chosen. */
export function isNotificationOnByDefault({
    type,
    delivery,
}: Readonly<{
    type: Readonly<Pick<NotificationType, 'isOptIn'>>;
    delivery: NotificationDelivery;
}>) {
    return defaultChoices[delivery](type);
}

/**
 * Whether the user gets `type`'s notifications by `delivery`. `folders` are the folders whose
 * overrides apply, nearest first: a worktree, then its repo. A folder's choice beats the global
 * one, which beats the type's default.
 */
export function isNotificationEnabled({
    settings,
    type,
    delivery,
    folders,
}: Readonly<{
    settings: Readonly<Pick<Settings, 'notifications' | 'folderNotifications'>>;
    type: Readonly<Pick<NotificationType, 'id' | 'isOptIn'>>;
    delivery: NotificationDelivery;
    folders: ReadonlyArray<string>;
}>) {
    const folderChoice = folders
        .map((folder) => {
            return (settings.folderNotifications || []).find((entry) => {
                return (
                    entry.folder === folder &&
                    entry.typeId === type.id &&
                    entry.delivery === delivery
                );
            });
        })
        .find((entry) => !!entry);
    const globalChoice = (settings.notifications || []).find((entry) => {
        return entry.typeId === type.id && entry.delivery === delivery;
    });
    return (
        (folderChoice || globalChoice)?.isEnabled ??
        isNotificationOnByDefault({
            type,
            delivery,
        })
    );
}
