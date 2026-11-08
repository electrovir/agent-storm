import {type FullSpaRoute} from 'spa-router-vir';
import {type ViraTabs} from 'vira';

/**
 * A `ViraTabs` router for tabs that aren't URL routes. It only lets `ViraTabs` render its links;
 * the click itself is handled by `tabSelect`.
 */
export const staticTabRouter: (typeof ViraTabs.InputsType)['router'] = {
    createRouteUrl(route) {
        return {
            url: '#',
            route: {
                paths: route.paths || [],
                search: undefined,
                hash: undefined,
            },
        };
    },
    setRouteOnDirectNavigation(route, event) {
        event.preventDefault();
        return false;
    },
};

/** The route {@link staticTabRouter} marks as selected: the tab whose `paths` is `[tabId]`. */
export function toStaticTabRoute(tabId: string | undefined): FullSpaRoute {
    return {
        paths: [
            tabId || '',
        ],
        search: undefined,
        hash: undefined,
    };
}
