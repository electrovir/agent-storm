import {type AnySettingsSectionContribution} from '@agent-storm/core/frontend';
import {diffSettingsSection} from '@agent-storm/plugin-diff';
import {reviewSettingsSection} from '@agent-storm/plugin-review';

/** Every plugin's page of the Settings modal. */
export const settingsSections: ReadonlyArray<AnySettingsSectionContribution> = [
    diffSettingsSection,
    reviewSettingsSection,
];
