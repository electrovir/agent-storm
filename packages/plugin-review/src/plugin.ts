import {definePlugin} from '@agent-storm/core/frontend';
import {getObjectTypedValues} from '@augment-vir/common';
import {reviewNotificationTypes} from './notification-types.js';
import {reviewActivityId} from './review-api.js';
import {reviewActivity} from './ui/elements/review-activity.js';
import {reviewPane} from './ui/elements/review-pane.js';
import {reviewSettingsSection} from './ui/elements/review-settings-section.js';
import {reviewExtension} from './util/review-extension.js';

export const reviewPlugin = definePlugin({
    id: reviewActivityId,
    name: 'Review',
    description: 'PR review queues and review tabs.',
    activities: [
        reviewActivity,
    ],
    panes: [
        reviewPane,
    ],
    paneGroupExtensions: [
        reviewExtension,
    ],
    settingsSections: [
        reviewSettingsSection,
    ],
    notificationTypes: getObjectTypedValues(reviewNotificationTypes),
});
