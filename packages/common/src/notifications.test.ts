import {assert} from '@augment-vir/assert';
import {describe, it} from '@augment-vir/test';
import {NotificationDelivery} from './enums.js';
import {isNotificationEnabled} from './notifications.js';

const type = {
    id: 'build:thread-finished',
    isOptIn: undefined,
};

const folders = [
    '/repo/worktree',
    '/repo',
];

describe(isNotificationEnabled.name, () => {
    it("uses the type's default when the user hasn't chosen", () => {
        assert.deepEquals(
            [
                type,
                {
                    ...type,
                    isOptIn: true,
                },
            ].map((eachType) => {
                return isNotificationEnabled({
                    settings: {},
                    type: eachType,
                    delivery: NotificationDelivery.Push,
                    folders,
                });
            }),
            [
                true,
                false,
            ],
        );
    });
    it('lets an explicit global off beat an on default', () => {
        assert.isFalse(
            isNotificationEnabled({
                settings: {
                    notifications: [
                        {
                            typeId: type.id,
                            delivery: NotificationDelivery.Push,
                            isEnabled: false,
                        },
                    ],
                },
                type,
                delivery: NotificationDelivery.Push,
                folders,
            }),
        );
    });
    it('lets the nearest folder choice beat the repo and global choices', () => {
        assert.isTrue(
            isNotificationEnabled({
                settings: {
                    notifications: [
                        {
                            typeId: type.id,
                            delivery: NotificationDelivery.InApp,
                            isEnabled: false,
                        },
                    ],
                    folderNotifications: [
                        {
                            folder: '/repo',
                            typeId: type.id,
                            delivery: NotificationDelivery.InApp,
                            isEnabled: false,
                        },
                        {
                            folder: '/repo/worktree',
                            typeId: type.id,
                            delivery: NotificationDelivery.InApp,
                            isEnabled: true,
                        },
                    ],
                },
                type,
                delivery: NotificationDelivery.InApp,
                folders,
            }),
        );
    });
});
