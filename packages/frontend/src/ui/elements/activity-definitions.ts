import {buildActivity} from '@agent-storm/build';
import {type AnyActivityDefinition} from '@agent-storm/core/frontend';
import {dashboardActivity} from '@agent-storm/dashboard';
import {debugActivity} from '@agent-storm/debug';
import {reviewActivity} from '@agent-storm/review';

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
