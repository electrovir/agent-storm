import {defineSettingsSection} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {reviewActivityId} from '../../review-api.js';
import {listQueueRepos} from '../../util/pr-queues.js';
import {type ReviewedRepo} from '../../util/pr-reviews.js';
import {findReviewState} from '../../util/review-state.js';
import {VirSettingsReview} from './vir-settings-review.element.js';

/** The init command run in each new review checkout, and the automation around reviews. */
export const reviewSettingsSection = defineSettingsSection<ReviewedRepo>({
    pluginId: reviewActivityId,
    name: 'settings',
    label: 'Review',
    searchTerms: [
        'init command',
        'pull request',
        'watch mode',
        'automatic',
    ],
    schemaCardTitle: 'Automation',
    schemaKeys: [
        'disableAutoWatchMode',
        'disableAutoManualReview',
    ],
    render({context, settings, details, changeSettings}) {
        return html`
            <${VirSettingsReview.assign({
                settings,
                reviewRepo: details,
                queueRepos: listQueueRepos(findReviewState(context).prQueues.value),
            })}
                ${listen(VirSettingsReview.events.settingsChange, (event) => {
                    changeSettings(event.detail);
                })}
            ></${VirSettingsReview}>
        `;
    },
});
