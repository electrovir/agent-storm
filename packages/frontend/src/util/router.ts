import {SpaRouter, type FullSpaRoute} from 'spa-router-vir';
import {activities} from '../ui/elements/activity-definitions.js';

/**
 * First path segment of the element-book route. It replaces the whole app chrome, so it's left
 * outside the activity strip (nesting it under an activity would also break existing deep links).
 */
export const bookRouteBase = 'book';

/**
 * `paths` when they start with an activity id, otherwise the first activity's bare route. A bare
 * `/` isn't valid, which is what sends it, and any unrecognized URL, to the first activity.
 */
export function sanitizeActivityPaths(paths: ReadonlyArray<string>): ReadonlyArray<string> {
    return activities.some((activity) => activity.id === paths[0])
        ? paths
        : [
              activities[0].id,
          ];
}

/**
 * The in-app URL: an activity id, then whatever that activity's own segments select, or the
 * element-book route.
 */
export const router = new SpaRouter<ReadonlyArray<string>, undefined, undefined>({
    sanitizeRoute(rawRoute) {
        return {
            paths:
                rawRoute.paths[0] === bookRouteBase
                    ? rawRoute.paths
                    : sanitizeActivityPaths(rawRoute.paths),
            search: undefined,
            hash: undefined,
        };
    },
});

export type AppRoute = Readonly<FullSpaRoute<ReadonlyArray<string>, undefined, undefined>>;
