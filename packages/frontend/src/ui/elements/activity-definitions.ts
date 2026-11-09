import {type AnyActivityDefinition} from '@agent-storm/core/frontend';
import {buildActivity} from '@agent-storm/plugin-build';
import {dashboardActivity} from '@agent-storm/plugin-dashboard';
import {debugActivity} from '@agent-storm/plugin-debug';
import {reviewActivity} from '@agent-storm/plugin-review';

/** Every activity, in the strip's default order. The first is where an unrecognized URL goes. */
export const activities: readonly [
    AnyActivityDefinition,
    ...ReadonlyArray<AnyActivityDefinition>,
] = [
    dashboardActivity,
    buildActivity,
    reviewActivity,
    debugActivity,
];
