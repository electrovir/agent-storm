import {SpaRouter, type FullSpaRoute} from 'spa-router-vir';

/**
 * First path segment of the element-book route. It replaces the whole app chrome, so it's left
 * outside the activity strip (nesting it under an activity would also break existing deep links).
 */
export const bookRouteBase = 'book';

/**
 * The in-app URL: an activity id, then whatever that activity's own segments select, or the
 * element-book route.
 */
export const router = new SpaRouter<ReadonlyArray<string>, undefined, undefined>({
    sanitizeRoute(rawRoute) {
        return {
            paths: rawRoute.paths,
            search: undefined,
            hash: undefined,
        };
    },
});

export type AppRoute = Readonly<FullSpaRoute<ReadonlyArray<string>, undefined, undefined>>;
