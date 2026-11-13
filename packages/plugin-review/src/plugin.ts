import {definePlugin} from '@agent-storm/core/frontend';
import {reviewActivity} from './ui/elements/review-activity.js';
import {reviewPane} from './ui/elements/review-pane.js';
import {reviewSettingsSection} from './ui/elements/review-settings-section.js';
import {reviewExtension} from './util/review-extension.js';
import {reviewActivityId} from './util/review-state.js';

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
});
