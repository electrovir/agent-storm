import {defineSettingsSection, SettingsSection} from '@agent-storm/core/frontend';
import {html, listen} from 'element-vir';
import {type ReviewedRepo} from '../../util/pr-reviews.js';
import {reviewActivityId} from '../../util/review-state.js';
import {VirSettingsReview} from './vir-settings-review.element.js';

/** The init command run in each new review checkout, and the automation around reviews. */
export const reviewSettingsSection = defineSettingsSection<ReviewedRepo>({
    pluginId: reviewActivityId,
    name: 'settings',
    label: 'Review',
    group: 'Agents',
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
    listAfter: SettingsSection.Folders,
    render({settings, details, changeSettings}) {
        return html`
            <${VirSettingsReview.assign({
                settings,
                reviewRepo: details,
            })}
                ${listen(VirSettingsReview.events.settingsChange, (event) => {
                    changeSettings(event.detail);
                })}
            ></${VirSettingsReview}>
        `;
    },
});
