import {type AnyPaneDefinition, type AnyPaneGroupExtension} from '@agent-storm/core/frontend';
import {diffPane} from '@agent-storm/plugin-diff';
import {reviewExtension, reviewPane} from '@agent-storm/plugin-review';
import {aiPane, shellPane} from '@agent-storm/plugin-terminal';
import {activityPane} from './activity-pane.js';

/** Every pane a pane group's tab can hold, in the new-tab menu's order. */
export const panes: ReadonlyArray<AnyPaneDefinition> = [
    aiPane,
    shellPane,
    diffPane,
    reviewPane,
    activityPane,
];

/** Every plugin's per-pane-group state, in the order each pane group syncs them. */
export const paneGroupExtensions: ReadonlyArray<AnyPaneGroupExtension> = [
    reviewExtension,
];
