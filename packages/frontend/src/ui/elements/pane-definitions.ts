import {type PaneDefinition} from '@agent-storm/core/frontend';
import {diffPane} from '@agent-storm/diff';
import {reviewPane} from '@agent-storm/review';
import {aiPane, shellPane} from '@agent-storm/terminal';
import {activityPane} from './activity-pane.js';

/** Every pane a pane group's tab can hold, in the new-tab menu's order. */
export const panes: ReadonlyArray<PaneDefinition> = [
    aiPane,
    shellPane,
    diffPane,
    reviewPane,
    activityPane,
];
